//! Native export: the editor hands over its snapshot and Rust renders, encodes
//! and muxes the whole file (`capptivo-engine`). No frame crosses the WebView.
//!
//! Destination handling follows the other export routes exactly: the
//! destination is claimed for writing, the file is written beside it and
//! promoted on success, and on any failure the destination is released so the
//! editor can fall back to another route or discard it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use capptivo_engine::document::RenderDocument;
use capptivo_engine::encode::EncoderSpec;
use capptivo_engine::export::{export, ExportRequest, ExportStats};
use capptivo_engine::EngineError;
use tauri::{AppHandle, Emitter, State};

use super::export::{
    claim_available_destination, export_temp_path, mark_destination_ready, promote_temp_to_final,
    release_destination, validate_project_file_name,
};
use crate::error::{AppError, AppResult};
use crate::recorder::encoder::{
    ffmpeg_path, ffprobe_path, prepare_export_audio, AudioEnhancePreset,
};
use crate::recorder::hw_encoder;
use crate::state::AppState;

/// Progress events, throttled to this interval.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
pub const PROGRESS_EVENT: &str = "export://native-progress";
/// A background image larger than this is not an image the editor produced.
const MAX_STAGED_ASSET_BYTES: usize = 64 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExportArgs {
    /// Caller-chosen id, used to cancel.
    job: String,
    destination: String,
    project_id: String,
    /// Bare file names inside the project directory.
    screen_file: String,
    camera_file: Option<String>,
    /// Token from [`stage_export_asset`] for the background image.
    background: Option<String>,
    document: RenderDocument,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u64,
    audio_preset: String,
    has_system_audio: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExportResult {
    frames: u64,
    seconds: f64,
    fps: f64,
    gpu: String,
    encoder: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeExportProgress<'a> {
    job: &'a str,
    done: u64,
    total: u64,
}

/// Keep bytes (the background image) for an upcoming native export; returns
/// the token `export_native` claims them with.
#[tauri::command(async)]
pub fn stage_export_asset(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Other(
            "stage_export_asset expects a raw byte body".into(),
        ));
    };
    if bytes.is_empty() || bytes.len() > MAX_STAGED_ASSET_BYTES {
        return Err(AppError::Other(format!(
            "staged export asset is {} bytes",
            bytes.len()
        )));
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    state
        .staged_export_assets
        .lock()
        .insert(token.clone(), bytes.clone());
    Ok(token)
}

/// Stop a running native export; a no-op once it has finished.
#[tauri::command(async)]
pub fn cancel_native_export(state: State<'_, AppState>, job: String) -> AppResult<()> {
    if let Some(flag) = state.native_exports.lock().get(&job) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Render, encode and mux the edited recording into `destination`.
#[tauri::command]
pub async fn export_native(
    app: AppHandle,
    state: State<'_, AppState>,
    args: NativeExportArgs,
) -> AppResult<NativeExportResult> {
    // Claim staged bytes first, so a rejected call never strands them.
    let background = match &args.background {
        Some(token) => Some(
            state
                .staged_export_assets
                .lock()
                .remove(token)
                .ok_or_else(|| AppError::Other("unknown staged export asset".into()))?,
        ),
        None => None,
    };
    validate_job_id(&args.job)?;
    validate_project_file_name(&args.screen_file)?;
    if let Some(camera) = &args.camera_file {
        validate_project_file_name(camera)?;
    }
    validate_output(args.width, args.height, args.fps)?;
    let dir = state.store.project_dir(&args.project_id)?;

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = state.native_exports.lock();
        if jobs.contains_key(&args.job) {
            return Err(AppError::Other(
                "native export job id already in use".into(),
            ));
        }
        jobs.insert(args.job.clone(), cancel.clone());
    }
    let final_path =
        match claim_available_destination(&state.export_destinations, &args.destination) {
            Ok(path) => path,
            Err(error) => {
                state.native_exports.lock().remove(&args.job);
                return Err(error);
            }
        };

    let job = args.job.clone();
    let destination = args.destination.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run(&app, args, &dir, background, &final_path, cancel)
    })
    .await
    .unwrap_or_else(|e| Err(AppError::Other(format!("native export task failed: {e}"))));

    state.native_exports.lock().remove(&job);
    match outcome {
        Ok((stats, encoder)) => {
            mark_destination_ready(&state.export_destinations, &destination)?;
            Ok(NativeExportResult {
                frames: stats.frames,
                seconds: stats.wall.as_secs_f64(),
                fps: stats.fps(),
                gpu: stats.gpu,
                encoder: encoder.to_string(),
            })
        }
        Err(error) => {
            let _ = release_destination(&state.export_destinations, &destination);
            Err(error)
        }
    }
}

fn run(
    app: &AppHandle,
    args: NativeExportArgs,
    dir: &Path,
    background: Option<Vec<u8>>,
    final_path: &Path,
    cancel: Arc<AtomicBool>,
) -> AppResult<(ExportStats, &'static str)> {
    let temp_path = export_temp_path(final_path);
    if temp_path.exists() {
        let _ = std::fs::remove_file(&temp_path);
    }
    let screen = dir.join(&args.screen_file);
    let camera = args
        .camera_file
        .as_ref()
        .map(|f| dir.join(f))
        .filter(|p| p.is_file());

    // Audio is trimmed (and enhanced) first, then muxed in the same pass as
    // the video — no second remux of the finished file.
    let audio = TempFile(dir.join(format!(
        "capptivo-export-audio-{}.m4a",
        uuid::Uuid::new_v4().simple()
    )));
    let segments: Vec<(f64, f64)> = args
        .document
        .kept_segments()
        .iter()
        .map(|s| (s.start.max(0.0), s.end.max(0.0)))
        .filter(|(s, e)| e > s)
        .collect();
    let has_audio = prepare_export_audio(
        &screen,
        &audio.0,
        &segments,
        AudioEnhancePreset::parse(&args.audio_preset),
        args.has_system_audio,
    )?;
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::Other("Export cancelled".into()));
    }

    let ffmpeg = ffmpeg_path();
    let choice = hw_encoder::pick_for(&ffmpeg, args.width, args.height);
    let request = ExportRequest {
        document: args.document,
        screen,
        camera,
        background,
        ffprobe: ffprobe_path(),
        encoder: EncoderSpec {
            ffmpeg,
            pre_input_args: choice
                .pre_input_args
                .iter()
                .map(|a| a.to_string())
                .collect(),
            video_args: choice.nv12_export_args(args.bitrate),
        },
        output: temp_path.clone(),
        width: args.width,
        height: args.height,
        fps: args.fps,
        audio: has_audio.then(|| audio.0.clone()),
    };

    let mut last_emit: Option<Instant> = None;
    let stats = export(
        &request,
        |p| {
            let due = last_emit.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL);
            if due || p.frames_done == p.frames_total {
                last_emit = Some(Instant::now());
                let _ = app.emit(
                    PROGRESS_EVENT,
                    NativeExportProgress {
                        job: &args.job,
                        done: p.frames_done,
                        total: p.frames_total,
                    },
                );
            }
        },
        cancel,
    )
    .map_err(|e| match e {
        EngineError::Cancelled => AppError::Other("Export cancelled".into()),
        other => AppError::Encoder(other.to_string()),
    })?;

    promote_temp_to_final(&temp_path, final_path)?;
    tracing::info!(encoder = choice.name, "native export: {stats}");
    Ok((stats, choice.name))
}

/// Deleted when dropped, whatever happened.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn validate_job_id(job: &str) -> AppResult<()> {
    if job.is_empty()
        || job.len() > 64
        || !job.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(AppError::Other("invalid native export job id".into()));
    }
    Ok(())
}

/// NV12 output needs a width divisible by 4 and an even height; the editor's
/// export sizes are multiples of 16.
fn validate_output(width: u32, height: u32, fps: u32) -> AppResult<()> {
    if width == 0
        || height == 0
        || !width.is_multiple_of(4)
        || !height.is_multiple_of(2)
        || width > 8192
        || height > 8192
    {
        return Err(AppError::Other(format!(
            "invalid export size {width}x{height}"
        )));
    }
    if !(1..=240).contains(&fps) {
        return Err(AppError::Other(format!("invalid export frame rate {fps}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_ids_are_plain_tokens() {
        assert!(validate_job_id("0f2c9a-11").is_ok());
        assert!(validate_job_id("").is_err());
        assert!(validate_job_id("../x").is_err());
        assert!(validate_job_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn output_sizes_must_fit_nv12() {
        assert!(validate_output(1920, 1072, 60).is_ok());
        assert!(validate_output(1922, 1080, 30).is_err());
        assert!(validate_output(1920, 1081, 30).is_err());
        assert!(validate_output(1920, 1080, 0).is_err());
    }
}

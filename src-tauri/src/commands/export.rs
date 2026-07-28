//! Export commands — the desktop [`ExportSink`](crate::state::ExportSink) side of
//! the editor's export pipeline. The WebView encodes; Rust only writes the file.
//!
//! Save-path picking lives in JS (`@tauri-apps/plugin-dialog` `save()`). Do **not**
//! call `blocking_save_file` from a command — on macOS that deadlocks AppKit with
//! Tauri's event loop (spinning beachball).

use crate::error::{AppError, AppResult};
use crate::recorder::encoder::{
    attach_export_audio as run_attach_export_audio,
    mux_export_audio as run_mux_export_audio,
    prepare_export_audio as run_prepare_export_audio,
    AudioEnhancePreset,
};
use crate::state::{AppState, ExportSink};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use tauri::State;

/// A kept timeline segment (source seconds) the export video is built from; the
/// audio is trimmed to match.
#[derive(serde::Deserialize)]
pub struct ExportAudioSegment {
    pub start: f64,
    pub end: f64,
}

/// Mux the recorded audio into a just-written (video-only) export, trimmed to the
/// kept `segments` and optionally voice-enhanced. Runs FFmpeg off the UI thread;
/// video is stream-copied so this is fast. `audio_source` is a bare filename in
/// the project directory (e.g. `screen.mp4`).
#[tauri::command]
pub async fn mux_export_audio(
    state: State<'_, AppState>,
    project_id: String,
    video_path: String,
    audio_source: String,
    segments: Vec<ExportAudioSegment>,
    preset: String,
    has_system_audio: bool,
) -> AppResult<()> {
    if audio_source.contains(['/', '\\']) || audio_source.contains("..") {
        return Err(AppError::Other("invalid export audio source".into()));
    }
    let audio_path = state.store.project_dir(&project_id).join(&audio_source);
    let video = PathBuf::from(video_path);
    let segs: Vec<(f64, f64)> = segments
        .into_iter()
        .map(|s| (s.start.max(0.0), s.end.max(0.0)))
        .filter(|(s, e)| e > s)
        .collect();
    let preset = AudioEnhancePreset::parse(&preset);

    tauri::async_runtime::spawn_blocking(move || {
        run_mux_export_audio(&video, &audio_path, &segs, preset, has_system_audio)
    })
    .await
    .map_err(|e| AppError::Other(format!("export audio mux task failed: {e}")))?
}

/// Trim (+ enhance) recorded audio to a sidecar in the project directory while
/// video encode runs. `out_name` is a bare filename (joined under the project
/// dir) so the WebView can read it back over `media://`. Returns the absolute
/// sidecar path when written, or `null` when the recording is silent.
#[tauri::command]
pub async fn prepare_export_audio(
    state: State<'_, AppState>,
    project_id: String,
    out_name: String,
    audio_source: String,
    segments: Vec<ExportAudioSegment>,
    preset: String,
    has_system_audio: bool,
) -> AppResult<Option<String>> {
    if audio_source.contains(['/', '\\']) || audio_source.contains("..") {
        return Err(AppError::Other("invalid export audio source".into()));
    }
    if out_name.contains(['/', '\\']) || out_name.contains("..") {
        return Err(AppError::Other("invalid export audio out name".into()));
    }
    let out = state.store.project_dir(&project_id).join(&out_name);
    let out_for_return = out.clone();
    let audio_path = state.store.project_dir(&project_id).join(&audio_source);
    let segs: Vec<(f64, f64)> = segments
        .into_iter()
        .map(|s| (s.start.max(0.0), s.end.max(0.0)))
        .filter(|(s, e)| e > s)
        .collect();
    let preset = AudioEnhancePreset::parse(&preset);

    let wrote = tauri::async_runtime::spawn_blocking(move || {
        run_prepare_export_audio(&audio_path, &out, &segs, preset, has_system_audio)
    })
    .await
    .map_err(|e| AppError::Other(format!("export audio prepare task failed: {e}")))??;

    Ok(if wrote {
        Some(out_for_return.to_string_lossy().into_owned())
    } else {
        None
    })
}

/// Stream-copy a prepared audio sidecar onto a video-only export.
#[tauri::command]
pub async fn attach_export_audio(video_path: String, audio_path: String) -> AppResult<()> {
    let video = PathBuf::from(video_path);
    let audio = PathBuf::from(audio_path);
    tauri::async_runtime::spawn_blocking(move || run_attach_export_audio(&video, &audio))
        .await
        .map_err(|e| AppError::Other(format!("export audio attach task failed: {e}")))?
}

/// Best-effort delete of an export temp sidecar (audio prepare leftover).
#[tauri::command]
pub async fn remove_temp_file(path: String) -> AppResult<()> {
    if path.contains("..") {
        return Err(AppError::Other("invalid temp path".into()));
    }
    let p = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::remove_file(&p);
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("remove temp file task failed: {e}")))?
}

/// Ensure a project's `screen.mp4` is a seekable progressive MP4 before export
/// reads it. New recordings are already finalized on stop; this migrates older
/// (fragmented) recordings on demand and is a fast no-op once progressive.
///
/// The export seek path (used whenever WebCodecs can't decode the recording's
/// codec — e.g. High-profile AVC at capture resolution) drives per-frame
/// `<video>` seeks, and WebKit can only seek a progressive MP4. Awaiting this
/// before rendering guarantees the file is seekable, so exports never freeze
/// past the first fragment.
#[tauri::command]
pub async fn ensure_seekable_recording(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<()> {
    let screen = state.store.project_dir(&project_id).join("screen.mp4");
    tauri::async_runtime::spawn_blocking(move || {
        crate::recorder::encoder::finalize_recording_mp4(&screen)
    })
    .await
    .map_err(|e| AppError::Other(format!("finalize task failed: {e}")))?
}

/// Open a file sink at `path` and return an opaque handle for the chunk writes.
///
/// `(async)` runs the body on the Tauri worker pool. A `#[tauri::command]` that
/// is neither `async fn` nor marked `(async)` executes *inline on the app's main
/// thread* — the one pumping the run loop and repainting every window — and
/// `File::create` on a slow or network volume is not something that thread
/// should be waiting on.
#[tauri::command(async)]
pub fn begin_export(state: State<AppState>, path: String) -> AppResult<u64> {
    let file = std::fs::File::create(&path)?;
    let mut next = state.next_export_id.lock();
    let handle = *next;
    *next += 1;
    drop(next);

    state.exports.lock().insert(
        handle,
        ExportSink {
            file,
            path: path.into(),
        },
    );
    Ok(handle)
}

/// Header names carrying the scalars that ride alongside the raw chunk body.
/// The bytes themselves are the *entire* invoke payload — that is the only
/// shape Tauri transfers as `application/octet-stream` (a `Uint8Array` nested
/// in an object is JSON-encoded as one decimal number per byte).
const EXPORT_HANDLE_HEADER: &str = "x-export-handle";
const EXPORT_POSITION_HEADER: &str = "x-export-position";

fn export_header(request: &tauri::ipc::Request<'_>, name: &str) -> AppResult<u64> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| AppError::Other(format!("missing or invalid {name} header")))
}

/// Write the request's raw body at absolute byte `position`. Streaming muxers
/// (mediabunny's `StreamTarget`) emit chunks out of order — e.g. seeking back
/// to patch an `mdat` box size — so writes are positioned, not append-only.
/// Sequential producers (GIF, `MediaRecorder`) simply pass a running offset.
///
/// `(async)` is load-bearing: a 16 MiB positioned write on the app's main thread
/// stalls every window for the length of the disk write, once per chunk, for the
/// whole export — and it sits directly in the export loop's critical path,
/// because `ExportSink.writable()` awaits each write before the encoder is
/// allowed to produce the next chunk.
///
/// Moving off the main thread does not reorder anything: `ExportSink.writable()`
/// hands mediabunny a `WritableStream`, and the spec invokes `write` for the
/// next chunk only once the previous promise has settled.
#[tauri::command(async)]
pub fn write_export_chunk(
    state: State<AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let handle = export_header(&request, EXPORT_HANDLE_HEADER)?;
    let position = export_header(&request, EXPORT_POSITION_HEADER)?;
    let tauri::ipc::InvokeBody::Raw(chunk) = request.body() else {
        return Err(AppError::Other(
            "write_export_chunk expects a raw byte body".into(),
        ));
    };

    let mut exports = state.exports.lock();
    let sink = exports
        .get_mut(&handle)
        .ok_or_else(|| AppError::Other(format!("unknown export handle {handle}")))?;
    sink.file.seek(SeekFrom::Start(position))?;
    sink.file.write_all(chunk)?;
    Ok(())
}

/// Flush and close the sink, returning the final file path.
///
/// `sync_all()` is an fsync of the entire exported video — seconds on a long
/// export — so it goes on the blocking pool rather than the main thread. This is
/// what the "Saving…" step used to freeze the whole app on.
#[tauri::command]
pub async fn finish_export(state: State<'_, AppState>, handle: u64) -> AppResult<String> {
    // The guard must not survive into the `.await` below: a `parking_lot` guard
    // is not `Send`, so holding it across the await would not compile — and the
    // map lock has no business being held for the length of an fsync anyway.
    let sink = state
        .exports
        .lock()
        .remove(&handle)
        .ok_or_else(|| AppError::Other(format!("unknown export handle {handle}")))?;

    tauri::async_runtime::spawn_blocking(move || {
        sink.file.sync_all()?;
        Ok(sink.path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| AppError::Other(format!("export finish task failed: {e}")))?
}

/// Abort an export: close and delete the partial file.
///
/// `(async)` — deleting a partial multi-GB export is filesystem work that does
/// not belong on the app's main thread.
#[tauri::command(async)]
pub fn abort_export(state: State<AppState>, handle: u64, reason: String) -> AppResult<()> {
    if let Some(sink) = state.exports.lock().remove(&handle) {
        tracing::info!(handle, %reason, "export aborted");
        drop(sink.file);
        let _ = std::fs::remove_file(&sink.path);
    }
    Ok(())
}

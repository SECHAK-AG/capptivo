//! Export commands — the desktop [`ExportSink`](crate::state::ExportSink) side of
//! the editor's export pipeline. The WebView encodes; Rust only writes the file.
//!
//! Save-path picking lives in JS (`@tauri-apps/plugin-dialog` `save()`). Do **not**
//! call `blocking_save_file` from a command — on macOS that deadlocks AppKit with
//! Tauri's event loop (spinning beachball).

use crate::error::{AppError, AppResult};
use crate::export_h264::H264StreamMuxer;
use crate::export_rawvideo::RawvideoStreamEncoder;
use crate::recorder::encoder::{
    attach_export_audio as run_attach_export_audio,
    mux_export_audio as run_mux_export_audio,
    prepare_export_audio as run_prepare_export_audio,
    AudioEnhancePreset,
};
use crate::state::{AppState, ExportSink};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::State;

/// Suffix for in-progress editor exports — removed on abort; renamed on success.
const EXPORT_PARTIAL_SUFFIX: &str = ".capptivo-export.partial";

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
    let audio_path = state.store.project_dir(&project_id)?.join(&audio_source);
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
    let out = state.store.project_dir(&project_id)?.join(&out_name);
    let out_for_return = out.clone();
    let audio_path = state.store.project_dir(&project_id)?.join(&audio_source);
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
    let screen = state.store.project_dir(&project_id)?.join("screen.mp4");
    tauri::async_runtime::spawn_blocking(move || {
        crate::recorder::encoder::finalize_recording_mp4(&screen)
    })
    .await
    .map_err(|e| AppError::Other(format!("finalize task failed: {e}")))?
}

/// Fail early when the volume hosting `path` cannot hold `needed` bytes.
/// No-op when free space cannot be determined (unsupported platform / odd path).
#[tauri::command(async)]
pub fn check_export_disk_space(path: String, needed: u64) -> AppResult<()> {
    let path = PathBuf::from(path);
    let available = volume_available_bytes(&path);
    if available.is_some_and(|free| free < needed) {
        return Err(AppError::Other(
            "Not enough free disk space to save the export here. Choose another location or free up space.".into(),
        ));
    }
    Ok(())
}

/// Open a file sink at `path` and return an opaque handle for the chunk writes.
///
/// Writes to a temp sidecar beside the destination so re-exporting over an
/// existing file does not truncate it until the muxer finishes and we rename.
///
/// `(async)` runs the body on the Tauri worker pool. A `#[tauri::command]` that
/// is neither `async fn` nor marked `(async)` executes *inline on the app's main
/// thread* — the one pumping the run loop and repainting every window — and
/// `File::create` on a slow or network volume is not something that thread
/// should be waiting on.
#[tauri::command(async)]
pub fn begin_export(state: State<AppState>, path: String) -> AppResult<u64> {
    let final_path = PathBuf::from(path);
    let temp_path = export_temp_path(&final_path);
    if temp_path.exists() {
        let _ = std::fs::remove_file(&temp_path);
    }
    let file = std::fs::File::create(&temp_path)?;
    let mut next = state.next_export_id.lock();
    let handle = *next;
    *next += 1;
    drop(next);

    state.exports.lock().insert(
        handle,
        ExportSink {
            file,
            path: temp_path,
            final_path: Some(final_path),
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

    tauri::async_runtime::spawn_blocking(move || finish_export_blocking(sink))
        .await
        .map_err(|e| AppError::Other(format!("export finish task failed: {e}")))?
}

fn finish_export_blocking(sink: ExportSink) -> AppResult<String> {
    sink.file.sync_all()?;
    let result_path = if let Some(final_path) = sink.final_path {
        promote_temp_to_final(&sink.path, &final_path)?;
        final_path
    } else {
        sink.path
    };
    Ok(result_path.to_string_lossy().into_owned())
}

/// Abort an export: close and delete the partial temp file only.
///
/// `(async)` — deleting a partial multi-GB export is filesystem work that does
/// not belong on the app's main thread.
#[tauri::command(async)]
pub fn abort_export(state: State<AppState>, handle: u64, reason: String) -> AppResult<()> {
    if let Some(sink) = state.exports.lock().remove(&handle) {
        tracing::error!(handle, %reason, "export aborted");
        drop(sink.file);
        let _ = std::fs::remove_file(&sink.path);
    }
    Ok(())
}

// --- Annex-B H.264 → ffmpeg MP4 (out-of-webview mux) -------------------------

/// Start ffmpeg reading Annex-B H.264 from IPC writes; output is a temp MP4
/// promoted on [`finish_export_h264_stream`].
#[tauri::command(async)]
pub fn begin_export_h264_stream(
    state: State<AppState>,
    path: String,
    fps: u32,
) -> AppResult<u64> {
    let final_path = PathBuf::from(path);
    let muxer = H264StreamMuxer::spawn(&final_path, fps)?;
    let mut next = state.next_export_id.lock();
    let handle = *next;
    *next += 1;
    drop(next);
    state.h264_exports.lock().insert(handle, muxer);
    Ok(handle)
}

const H264_HANDLE_HEADER: &str = "x-export-handle";

/// Append one Annex-B chunk to the ffmpeg stdin pipe.
#[tauri::command(async)]
pub fn write_export_h264_chunk(
    state: State<AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let handle = export_header(&request, H264_HANDLE_HEADER)?;
    let tauri::ipc::InvokeBody::Raw(chunk) = request.body() else {
        return Err(AppError::Other(
            "write_export_h264_chunk expects a raw byte body".into(),
        ));
    };
    let mut exports = state.h264_exports.lock();
    let muxer = exports
        .get_mut(&handle)
        .ok_or_else(|| AppError::Other(format!("unknown h264 export handle {handle}")))?;
    muxer.write_chunk(chunk)
}

#[tauri::command]
pub async fn finish_export_h264_stream(
    state: State<'_, AppState>,
    handle: u64,
) -> AppResult<String> {
    let muxer = state
        .h264_exports
        .lock()
        .remove(&handle)
        .ok_or_else(|| AppError::Other(format!("unknown h264 export handle {handle}")))?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = muxer.finish()?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| AppError::Other(format!("h264 export finish task failed: {e}")))?
}

#[tauri::command(async)]
pub fn abort_export_h264_stream(
    state: State<AppState>,
    handle: u64,
    reason: String,
) -> AppResult<()> {
    if let Some(muxer) = state.h264_exports.lock().remove(&handle) {
        tracing::error!(handle, %reason, "h264 export aborted");
        muxer.abort();
    }
    Ok(())
}

// --- RGBA frames → ffmpeg H.264 encode (Path B; encode outside WebView) ------

/// Start ffmpeg reading RGBA frames from IPC writes; encodes with the probed
/// hardware encoder (same pick as recording).
#[tauri::command(async)]
pub fn begin_export_rawvideo_stream(
    state: State<AppState>,
    path: String,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
) -> AppResult<u64> {
    let final_path = PathBuf::from(path);
    let encoder = RawvideoStreamEncoder::spawn(&final_path, width, height, fps, bitrate)?;
    let mut next = state.next_export_id.lock();
    let handle = *next;
    *next += 1;
    drop(next);
    state.rawvideo_exports.lock().insert(handle, encoder);
    Ok(handle)
}

const RAWVIDEO_HANDLE_HEADER: &str = "x-export-handle";

/// Append one full RGBA frame to the ffmpeg stdin pipe.
#[tauri::command(async)]
pub fn write_export_rawvideo_frame(
    state: State<AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let handle = export_header(&request, RAWVIDEO_HANDLE_HEADER)?;
    let tauri::ipc::InvokeBody::Raw(chunk) = request.body() else {
        return Err(AppError::Other(
            "write_export_rawvideo_frame expects a raw byte body".into(),
        ));
    };
    let mut exports = state.rawvideo_exports.lock();
    let encoder = exports
        .get_mut(&handle)
        .ok_or_else(|| AppError::Other(format!("unknown rawvideo export handle {handle}")))?;
    encoder.write_frame(chunk)
}

#[tauri::command]
pub async fn finish_export_rawvideo_stream(
    state: State<'_, AppState>,
    handle: u64,
) -> AppResult<String> {
    let encoder = state
        .rawvideo_exports
        .lock()
        .remove(&handle)
        .ok_or_else(|| AppError::Other(format!("unknown rawvideo export handle {handle}")))?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = encoder.finish()?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| AppError::Other(format!("rawvideo export finish task failed: {e}")))?
}

#[tauri::command(async)]
pub fn abort_export_rawvideo_stream(
    state: State<AppState>,
    handle: u64,
    reason: String,
) -> AppResult<()> {
    if let Some(encoder) = state.rawvideo_exports.lock().remove(&handle) {
        tracing::error!(handle, %reason, "rawvideo export aborted");
        encoder.abort();
    }
    Ok(())
}

fn export_temp_path(final_path: &Path) -> PathBuf {
    let mut os = final_path.as_os_str().to_os_string();
    os.push(EXPORT_PARTIAL_SUFFIX);
    PathBuf::from(os)
}

/// Rename a completed temp export onto the user path. The destination is only
/// replaced once the temp file is fully written and fsynced.
fn promote_temp_to_final(temp: &Path, final_path: &Path) -> AppResult<()> {
    if final_path.exists() {
        std::fs::remove_file(final_path)?;
    }
    std::fs::rename(temp, final_path).map_err(|e| {
        let _ = std::fs::remove_file(temp);
        AppError::Other(format!("export rename failed: {e}"))
    })?;
    Ok(())
}

/// Free bytes on the volume hosting `path`. `None` when unknown — callers skip
/// the precheck rather than blocking export.
fn volume_available_bytes(path: &Path) -> Option<u64> {
    let check = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(path);
    volume_available_bytes_at(check)
}

#[cfg(unix)]
fn volume_available_bytes_at(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let cpath = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(cpath.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    Some(stat.f_bavail as u64 * stat.f_bsize as u64)
}

#[cfg(target_os = "windows")]
fn volume_available_bytes_at(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect();
    let mut free = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None).is_ok()
    };
    ok.then_some(free)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn volume_available_bytes_at(_path: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn export_temp_rename_leaves_final_and_removes_partial() {
        let dir = std::env::temp_dir().join(format!(
            "capptivo-export-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("out.mp4");
        std::fs::write(&final_path, b"original").unwrap();

        let temp_path = export_temp_path(&final_path);
        let mut file = std::fs::File::create(&temp_path).unwrap();
        file.write_all(b"new-export").unwrap();

        let sink = ExportSink {
            file,
            path: temp_path.clone(),
            final_path: Some(final_path.clone()),
        };

        let saved = finish_export_blocking(sink).unwrap();
        assert_eq!(saved, final_path.to_string_lossy());
        assert!(!temp_path.exists());
        assert!(final_path.is_file());

        let mut got = String::new();
        std::fs::File::open(&final_path)
            .unwrap()
            .read_to_string(&mut got)
            .unwrap();
        assert_eq!(got, "new-export");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn abort_export_removes_only_temp() {
        let dir = std::env::temp_dir().join(format!(
            "capptivo-export-abort-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let final_path = dir.join("keep.mp4");
        std::fs::write(&final_path, b"keep-me").unwrap();

        let temp_path = export_temp_path(&final_path);
        std::fs::write(&temp_path, b"partial").unwrap();

        let _ = std::fs::remove_file(&temp_path);
        assert!(final_path.is_file());
        let mut got = String::new();
        std::fs::File::open(&final_path)
            .unwrap()
            .read_to_string(&mut got)
            .unwrap();
        assert_eq!(got, "keep-me");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

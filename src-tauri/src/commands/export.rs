//! Export commands — the desktop [`ExportSink`](crate::state::ExportSink) side of
//! the editor's export pipeline. The WebView encodes, while Rust owns every path
//! used for destination and temporary-file IO.

use crate::error::{AppError, AppResult};
use crate::export_h264::H264StreamMuxer;
use crate::export_rawvideo::RawvideoStreamEncoder;
use crate::recorder::encoder::{
    attach_export_audio as run_attach_export_audio, mux_export_audio as run_mux_export_audio,
    prepare_export_audio as run_prepare_export_audio, AudioEnhancePreset,
};
use crate::state::{
    AppState, ExportDestination, ExportDestinationState, ExportSink, FileExport, H264Export,
    H264ExportSlot, RawvideoExport, RawvideoExportSlot, StreamExportSlot,
};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Suffix for in-progress editor exports — removed on abort; renamed on success.
const EXPORT_PARTIAL_SUFFIX: &str = ".capptivo-export.partial";

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFileType {
    Mp4,
    Webm,
    Gif,
}

impl ExportFileType {
    fn filter(&self) -> (&'static str, &'static str) {
        match self {
            Self::Mp4 => ("MP4 video", "mp4"),
            Self::Webm => ("WebM video", "webm"),
            Self::Gif => ("GIF animation", "gif"),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDestinationSelection {
    handle: String,
    display_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedExportAudioSelection {
    handle: String,
    file_name: String,
}

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
    destination: String,
    project_id: String,
    audio_source: String,
    segments: Vec<ExportAudioSegment>,
    preset: String,
    has_system_audio: bool,
) -> AppResult<()> {
    validate_project_file_name(&audio_source)?;
    let audio_path = state.store.project_dir(&project_id)?.join(&audio_source);
    let video = claim_ready_destination(&state.export_destinations, &destination)?;
    let segs: Vec<(f64, f64)> = segments
        .into_iter()
        .map(|s| (s.start.max(0.0), s.end.max(0.0)))
        .filter(|(s, e)| e > s)
        .collect();
    let preset = AudioEnhancePreset::parse(&preset);

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_mux_export_audio(&video, &audio_path, &segs, preset, has_system_audio)
    })
    .await
    .unwrap_or_else(|e| {
        Err(AppError::Other(format!(
            "export audio mux task failed: {e}"
        )))
    });
    finish_destination_processing(&state.export_destinations, &destination)?;
    result
}

/// Trim (+ enhance) recorded audio to a sidecar in the project directory while
/// video encode runs. `out_name` is a bare filename (joined under the project
/// dir) so the WebView can read it back over `media://`. Returns an opaque handle
/// and project-relative filename when written, or `null` when the recording is
/// silent.
#[tauri::command]
pub async fn prepare_export_audio(
    state: State<'_, AppState>,
    project_id: String,
    file_ext: String,
    audio_source: String,
    segments: Vec<ExportAudioSegment>,
    preset: String,
    has_system_audio: bool,
) -> AppResult<Option<PreparedExportAudioSelection>> {
    validate_project_file_name(&audio_source)?;
    if !matches!(file_ext.as_str(), "m4a" | "webm") {
        return Err(AppError::Other("invalid export audio file type".into()));
    }
    let handle = uuid::Uuid::new_v4().simple().to_string();
    let out_name = format!("capptivo-export-audio-{handle}.{file_ext}");
    let out = state.store.project_dir(&project_id)?.join(&out_name);
    let out_for_cleanup = out.clone();
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

    if !wrote {
        return Ok(None);
    }

    if state
        .prepared_export_audio
        .lock()
        .insert(handle.clone(), out_for_cleanup.clone())
        .is_some()
    {
        let _ = std::fs::remove_file(out_for_cleanup);
        return Err(AppError::Other(
            "duplicate prepared export audio handle".into(),
        ));
    }

    Ok(Some(PreparedExportAudioSelection {
        handle,
        file_name: out_name,
    }))
}

/// Stream-copy a prepared audio sidecar onto a video-only export.
#[tauri::command]
pub async fn attach_export_audio(
    state: State<'_, AppState>,
    destination: String,
    audio: String,
) -> AppResult<()> {
    let audio_path = state
        .prepared_export_audio
        .lock()
        .get(&audio)
        .cloned()
        .ok_or_else(|| AppError::Other("unknown prepared export audio handle".into()))?;
    let video = claim_ready_destination(&state.export_destinations, &destination)?;
    let result =
        tauri::async_runtime::spawn_blocking(move || run_attach_export_audio(&video, &audio_path))
            .await
            .unwrap_or_else(|e| {
                Err(AppError::Other(format!(
                    "export audio attach task failed: {e}"
                )))
            });
    finish_destination_processing(&state.export_destinations, &destination)?;
    result
}

/// Best-effort delete of an export temp sidecar (audio prepare leftover).
#[tauri::command]
pub async fn remove_temp_file(state: State<'_, AppState>, handle: String) -> AppResult<()> {
    let path = state
        .prepared_export_audio
        .lock()
        .remove(&handle)
        .ok_or_else(|| AppError::Other("unknown prepared export audio handle".into()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::remove_file(path);
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

/// Ask the native save dialog for a destination and retain its path in Rust.
/// The renderer receives only an opaque capability and a filename for display.
#[tauri::command]
pub async fn select_export_destination(
    window: WebviewWindow,
    state: State<'_, AppState>,
    suggested_name: String,
    file_type: ExportFileType,
    needed: u64,
) -> AppResult<Option<ExportDestinationSelection>> {
    validate_suggested_name(&suggested_name)?;
    let (filter_name, extension) = file_type.filter();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(suggested_name)
        .add_filter(filter_name, &[extension])
        .save_file(move |selection| {
            let _ = send.send(selection);
        });

    let selection = tauri::async_runtime::spawn_blocking(move || receive.recv())
        .await
        .map_err(|e| AppError::Other(format!("export save dialog task failed: {e}")))?
        .map_err(|_| AppError::Other("export save dialog closed unexpectedly".into()))?;
    let Some(selection) = selection else {
        return Ok(None);
    };
    let path = selection
        .into_path()
        .map_err(|e| AppError::Other(format!("invalid export destination: {e}")))?;
    if path.as_os_str().is_empty() {
        return Err(AppError::Other("invalid empty export destination".into()));
    }

    let available = volume_available_bytes(&path);
    if available.is_some_and(|free| free < needed) {
        return Err(AppError::Other(
            "Not enough free disk space to save the export here. Choose another location or free up space.".into(),
        ));
    }

    let display_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned();
    let handle = uuid::Uuid::new_v4().simple().to_string();
    reserve_destination(&state.export_destinations, handle.clone(), path)?;

    Ok(Some(ExportDestinationSelection {
        handle,
        display_name,
    }))
}

fn validate_suggested_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err(AppError::Other("invalid export filename".into()));
    }
    Ok(())
}

fn validate_project_file_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err(AppError::Other("invalid export audio source".into()));
    }
    Ok(())
}

fn reserve_destination(
    destinations: &parking_lot::Mutex<std::collections::HashMap<String, ExportDestination>>,
    handle: String,
    path: PathBuf,
) -> AppResult<()> {
    let reservation_keys = [
        destination_reservation_key(&path),
        destination_reservation_key(&export_temp_path(&path)),
    ];
    let mut destinations = destinations.lock();
    if destinations.contains_key(&handle) {
        return Err(AppError::Other(
            "duplicate export destination handle".into(),
        ));
    }
    if destinations.values().any(|destination| {
        destination
            .reservation_keys
            .iter()
            .any(|key| reservation_keys.contains(key))
    }) {
        return Err(AppError::Other(
            "That export destination is already in use. Choose another location or wait for the current export to finish.".into(),
        ));
    }
    destinations.insert(
        handle,
        ExportDestination {
            path,
            reservation_keys,
            state: ExportDestinationState::Available,
        },
    );
    Ok(())
}

fn destination_reservation_key(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let normalized = absolute.canonicalize().unwrap_or_else(|_| {
        match (absolute.parent(), absolute.file_name()) {
            (Some(parent), Some(file_name)) => parent
                .canonicalize()
                .unwrap_or_else(|_| parent.to_path_buf())
                .join(file_name),
            _ => absolute,
        }
    });
    let key = normalized.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        key.replace('/', "\\").to_lowercase()
    }
    #[cfg(target_os = "macos")]
    {
        key.to_lowercase()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        key
    }
}

fn claim_available_destination(
    destinations: &parking_lot::Mutex<std::collections::HashMap<String, ExportDestination>>,
    handle: &str,
) -> AppResult<PathBuf> {
    let mut destinations = destinations.lock();
    let destination = destinations
        .get_mut(handle)
        .ok_or_else(|| AppError::Other("unknown export destination handle".into()))?;
    if destination.state != ExportDestinationState::Available {
        return Err(AppError::Other(
            "export destination is not available".into(),
        ));
    }
    destination.state = ExportDestinationState::Writing;
    Ok(destination.path.clone())
}

fn transition_destination(
    destinations: &parking_lot::Mutex<std::collections::HashMap<String, ExportDestination>>,
    handle: &str,
    from: ExportDestinationState,
    to: ExportDestinationState,
) -> AppResult<()> {
    let mut destinations = destinations.lock();
    let destination = destinations
        .get_mut(handle)
        .ok_or_else(|| AppError::Other("unknown export destination handle".into()))?;
    if destination.state != from {
        return Err(AppError::Other("invalid export destination state".into()));
    }
    destination.state = to;
    Ok(())
}

fn release_destination(
    destinations: &parking_lot::Mutex<std::collections::HashMap<String, ExportDestination>>,
    handle: &str,
) -> AppResult<()> {
    transition_destination(
        destinations,
        handle,
        ExportDestinationState::Writing,
        ExportDestinationState::Available,
    )
}

fn mark_destination_ready(
    destinations: &parking_lot::Mutex<std::collections::HashMap<String, ExportDestination>>,
    handle: &str,
) -> AppResult<()> {
    transition_destination(
        destinations,
        handle,
        ExportDestinationState::Writing,
        ExportDestinationState::Ready,
    )
}

fn claim_ready_destination(
    destinations: &parking_lot::Mutex<std::collections::HashMap<String, ExportDestination>>,
    handle: &str,
) -> AppResult<PathBuf> {
    let mut destinations = destinations.lock();
    let destination = destinations
        .get_mut(handle)
        .ok_or_else(|| AppError::Other("unknown export destination handle".into()))?;
    if destination.state != ExportDestinationState::Ready {
        return Err(AppError::Other("export destination is not ready".into()));
    }
    destination.state = ExportDestinationState::Processing;
    Ok(destination.path.clone())
}

fn finish_destination_processing(
    destinations: &parking_lot::Mutex<std::collections::HashMap<String, ExportDestination>>,
    handle: &str,
) -> AppResult<()> {
    transition_destination(
        destinations,
        handle,
        ExportDestinationState::Processing,
        ExportDestinationState::Ready,
    )
}

enum DestinationAfterFailedWrite {
    Release,
    Retire,
}

enum StreamWriteEnd<T> {
    Restored,
    Abort {
        export: T,
        error: AppError,
        destination: DestinationAfterFailedWrite,
    },
}

fn finish_stream_write<T>(
    exports: &parking_lot::Mutex<std::collections::HashMap<String, StreamExportSlot<T>>>,
    handle: String,
    export: T,
    result: AppResult<()>,
    stream_name: &str,
) -> StreamWriteEnd<T> {
    let mut exports = exports.lock();
    match exports.remove(&handle) {
        Some(StreamExportSlot::Writing {
            cancel_requested: true,
            ..
        }) => StreamWriteEnd::Abort {
            export,
            error: AppError::Other(format!("{stream_name} export was cancelled")),
            destination: DestinationAfterFailedWrite::Retire,
        },
        Some(StreamExportSlot::Writing {
            cancel_requested: false,
            ..
        }) => match result {
            Ok(()) => {
                exports.insert(handle, StreamExportSlot::Ready(export));
                StreamWriteEnd::Restored
            }
            Err(error) => StreamWriteEnd::Abort {
                export,
                error,
                destination: DestinationAfterFailedWrite::Release,
            },
        },
        Some(StreamExportSlot::Ready(_)) => StreamWriteEnd::Abort {
            export,
            error: AppError::Other(format!(
                "{stream_name} export handle {handle} entered an invalid state during write"
            )),
            destination: DestinationAfterFailedWrite::Retire,
        },
        None => StreamWriteEnd::Abort {
            export,
            error: AppError::Other(format!(
                "{stream_name} export handle {handle} disappeared during write"
            )),
            destination: DestinationAfterFailedWrite::Retire,
        },
    }
}

fn take_or_cancel_stream<T>(
    exports: &parking_lot::Mutex<std::collections::HashMap<String, StreamExportSlot<T>>>,
    handle: &str,
) -> Option<T> {
    let mut exports = exports.lock();
    match exports.remove(handle)? {
        StreamExportSlot::Ready(export) => Some(export),
        StreamExportSlot::Writing { destination, .. } => {
            exports.insert(
                handle.to_owned(),
                StreamExportSlot::Writing {
                    destination,
                    cancel_requested: true,
                },
            );
            None
        }
    }
}

fn take_ready_stream<T>(
    exports: &parking_lot::Mutex<std::collections::HashMap<String, StreamExportSlot<T>>>,
    handle: &str,
    stream_name: &str,
) -> AppResult<T> {
    let mut exports = exports.lock();
    match exports.remove(handle) {
        Some(StreamExportSlot::Ready(export)) => Ok(export),
        Some(slot @ StreamExportSlot::Writing { .. }) => {
            exports.insert(handle.to_owned(), slot);
            Err(AppError::Other(format!(
                "{stream_name} export handle {handle} has a write in progress"
            )))
        }
        None => Err(AppError::Other(format!(
            "unknown {stream_name} export handle {handle}"
        ))),
    }
}

/// Open a file sink for `destination` and return an opaque stream handle.
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
pub fn begin_export(state: State<AppState>, destination: String) -> AppResult<String> {
    let final_path = claim_available_destination(&state.export_destinations, &destination)?;
    let temp_path = export_temp_path(&final_path);
    if temp_path.exists() {
        let _ = std::fs::remove_file(&temp_path);
    }
    let file = match std::fs::File::create(&temp_path) {
        Ok(file) => file,
        Err(error) => {
            let _ = release_destination(&state.export_destinations, &destination);
            return Err(error.into());
        }
    };
    let handle = new_export_stream_handle();

    state.exports.lock().insert(
        handle.clone(),
        FileExport {
            sink: ExportSink {
                file,
                path: temp_path,
                final_path: Some(final_path),
            },
            destination,
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

fn new_export_stream_handle() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn normalize_export_stream_handle(handle: &str) -> AppResult<String> {
    uuid::Uuid::parse_str(handle)
        .map(|value| value.simple().to_string())
        .map_err(|_| AppError::Other("invalid export stream handle".into()))
}

fn export_handle_header(request: &tauri::ipc::Request<'_>, name: &str) -> AppResult<String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Other(format!("missing or invalid {name} header")))
        .and_then(normalize_export_stream_handle)
}

fn export_u64_header(request: &tauri::ipc::Request<'_>, name: &str) -> AppResult<u64> {
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
    let handle = export_handle_header(&request, EXPORT_HANDLE_HEADER)?;
    let position = export_u64_header(&request, EXPORT_POSITION_HEADER)?;
    let tauri::ipc::InvokeBody::Raw(chunk) = request.body() else {
        return Err(AppError::Other(
            "write_export_chunk expects a raw byte body".into(),
        ));
    };

    let mut exports = state.exports.lock();
    let sink = exports
        .get_mut(&handle)
        .ok_or_else(|| AppError::Other(format!("unknown export handle {handle}")))?;
    sink.sink.file.seek(SeekFrom::Start(position))?;
    sink.sink.file.write_all(chunk)?;
    Ok(())
}

/// Flush, close, and mark the selected destination ready for post-processing.
///
/// `sync_all()` is an fsync of the entire exported video — seconds on a long
/// export — so it goes on the blocking pool rather than the main thread. This is
/// what the "Saving…" step used to freeze the whole app on.
#[tauri::command]
pub async fn finish_export(state: State<'_, AppState>, handle: String) -> AppResult<()> {
    let handle = normalize_export_stream_handle(&handle)?;
    // The guard must not survive into the `.await` below: a `parking_lot` guard
    // is not `Send`, so holding it across the await would not compile — and the
    // map lock has no business being held for the length of an fsync anyway.
    let sink = state
        .exports
        .lock()
        .remove(&handle)
        .ok_or_else(|| AppError::Other(format!("unknown export handle {handle}")))?;

    let destination = sink.destination;
    let result = tauri::async_runtime::spawn_blocking(move || finish_export_blocking(sink.sink))
        .await
        .unwrap_or_else(|e| Err(AppError::Other(format!("export finish task failed: {e}"))));
    if result.is_ok() {
        mark_destination_ready(&state.export_destinations, &destination)?;
    } else {
        let _ = release_destination(&state.export_destinations, &destination);
    }
    result
}

fn finish_export_blocking(sink: ExportSink) -> AppResult<()> {
    sink.file.sync_all()?;
    if let Some(final_path) = sink.final_path {
        promote_temp_to_final(&sink.path, &final_path)?;
    }
    Ok(())
}

/// Abort an export: close and delete the partial temp file only.
///
/// `(async)` — deleting a partial multi-GB export is filesystem work that does
/// not belong on the app's main thread.
#[tauri::command(async)]
pub fn abort_export(state: State<AppState>, handle: String, reason: String) -> AppResult<()> {
    let handle = normalize_export_stream_handle(&handle)?;
    if let Some(sink) = state.exports.lock().remove(&handle) {
        tracing::error!(%handle, %reason, "export aborted");
        drop(sink.sink.file);
        let _ = std::fs::remove_file(&sink.sink.path);
        release_destination(&state.export_destinations, &sink.destination)?;
    }
    Ok(())
}

// --- Annex-B H.264 → ffmpeg MP4 (out-of-webview mux) -------------------------

/// Start ffmpeg reading Annex-B H.264 from IPC writes; output is a temp MP4
/// promoted on [`finish_export_h264_stream`].
#[tauri::command(async)]
pub fn begin_export_h264_stream(
    state: State<AppState>,
    destination: String,
    fps: u32,
) -> AppResult<String> {
    let final_path = claim_available_destination(&state.export_destinations, &destination)?;
    let muxer = match H264StreamMuxer::spawn(&final_path, fps) {
        Ok(muxer) => muxer,
        Err(error) => {
            let _ = release_destination(&state.export_destinations, &destination);
            return Err(error);
        }
    };
    let handle = new_export_stream_handle();
    state.h264_exports.lock().insert(
        handle.clone(),
        H264ExportSlot::Ready(H264Export { muxer, destination }),
    );
    Ok(handle)
}

const H264_HANDLE_HEADER: &str = "x-export-handle";

/// Append one Annex-B chunk to the ffmpeg stdin pipe.
///
/// Keep a cancellable placeholder in the map while the blocking pipe write owns
/// the muxer, so abort and finish never wait behind a full OS pipe.
#[tauri::command(async)]
pub fn write_export_h264_chunk(
    state: State<AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let handle = export_handle_header(&request, H264_HANDLE_HEADER)?;
    let tauri::ipc::InvokeBody::Raw(chunk) = request.body() else {
        return Err(AppError::Other(
            "write_export_h264_chunk expects a raw byte body".into(),
        ));
    };
    let mut exports = state.h264_exports.lock();
    let Some(slot) = exports.remove(&handle) else {
        return Err(AppError::Other(format!(
            "unknown h264 export handle {handle}"
        )));
    };
    let mut export = match slot {
        H264ExportSlot::Ready(export) => export,
        slot @ H264ExportSlot::Writing { .. } => {
            exports.insert(handle.clone(), slot);
            return Err(AppError::Other(format!(
                "h264 export handle {handle} already has a write in progress"
            )));
        }
    };
    exports.insert(
        handle.clone(),
        H264ExportSlot::Writing {
            destination: export.destination.clone(),
            cancel_requested: false,
        },
    );
    drop(exports);

    let result = export.muxer.write_chunk(chunk);
    match finish_stream_write(&state.h264_exports, handle, export, result, "h264") {
        StreamWriteEnd::Restored => Ok(()),
        StreamWriteEnd::Abort {
            export,
            error,
            destination,
        } => {
            let destination_handle = export.destination;
            export.muxer.abort();
            match destination {
                DestinationAfterFailedWrite::Release => {
                    let _ = release_destination(&state.export_destinations, &destination_handle);
                }
                DestinationAfterFailedWrite::Retire => {
                    let _ = remove_destination(
                        &state.export_destinations,
                        &destination_handle,
                        &[ExportDestinationState::Writing],
                    );
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn finish_export_h264_stream(
    state: State<'_, AppState>,
    handle: String,
) -> AppResult<()> {
    let handle = normalize_export_stream_handle(&handle)?;
    let export = take_ready_stream(&state.h264_exports, &handle, "h264")?;
    let destination = export.destination;
    let result = tauri::async_runtime::spawn_blocking(move || export.muxer.finish())
        .await
        .unwrap_or_else(|e| {
            Err(AppError::Other(format!(
                "h264 export finish task failed: {e}"
            )))
        });
    if result.is_ok() {
        mark_destination_ready(&state.export_destinations, &destination)?;
    } else {
        let _ = release_destination(&state.export_destinations, &destination);
    }
    result.map(|_| ())
}

#[tauri::command(async)]
pub fn abort_export_h264_stream(
    state: State<AppState>,
    handle: String,
    reason: String,
) -> AppResult<()> {
    let handle = normalize_export_stream_handle(&handle)?;
    if let Some(export) = take_or_cancel_stream(&state.h264_exports, &handle) {
        tracing::error!(%handle, %reason, "h264 export aborted");
        export.muxer.abort();
        release_destination(&state.export_destinations, &export.destination)?;
    }
    Ok(())
}

// --- RGBA frames → ffmpeg H.264 encode (Path B; encode outside WebView) ------

/// Start ffmpeg reading RGBA frames from IPC writes; encodes with the probed
/// hardware encoder (same pick as recording).
#[tauri::command(async)]
pub fn begin_export_rawvideo_stream(
    state: State<AppState>,
    destination: String,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
) -> AppResult<String> {
    let final_path = claim_available_destination(&state.export_destinations, &destination)?;
    let encoder = match RawvideoStreamEncoder::spawn(&final_path, width, height, fps, bitrate) {
        Ok(encoder) => encoder,
        Err(error) => {
            let _ = release_destination(&state.export_destinations, &destination);
            return Err(error);
        }
    };
    let handle = new_export_stream_handle();
    state.rawvideo_exports.lock().insert(
        handle.clone(),
        RawvideoExportSlot::Ready(RawvideoExport {
            encoder,
            destination,
        }),
    );
    Ok(handle)
}

const RAWVIDEO_HANDLE_HEADER: &str = "x-export-handle";

/// Append one full RGBA frame to the ffmpeg stdin pipe.
///
/// Keep a cancellable placeholder in the map while the blocking pipe write owns
/// the encoder, so abort and finish never wait behind a full OS pipe.
#[tauri::command(async)]
pub fn write_export_rawvideo_frame(
    state: State<AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let handle = export_handle_header(&request, RAWVIDEO_HANDLE_HEADER)?;
    let tauri::ipc::InvokeBody::Raw(chunk) = request.body() else {
        return Err(AppError::Other(
            "write_export_rawvideo_frame expects a raw byte body".into(),
        ));
    };
    let mut exports = state.rawvideo_exports.lock();
    let Some(slot) = exports.remove(&handle) else {
        return Err(AppError::Other(format!(
            "unknown rawvideo export handle {handle}"
        )));
    };
    let mut export = match slot {
        RawvideoExportSlot::Ready(export) => export,
        slot @ RawvideoExportSlot::Writing { .. } => {
            exports.insert(handle.clone(), slot);
            return Err(AppError::Other(format!(
                "rawvideo export handle {handle} already has a write in progress"
            )));
        }
    };
    exports.insert(
        handle.clone(),
        RawvideoExportSlot::Writing {
            destination: export.destination.clone(),
            cancel_requested: false,
        },
    );
    drop(exports);

    let result = export.encoder.write_frame(chunk);
    match finish_stream_write(&state.rawvideo_exports, handle, export, result, "rawvideo") {
        StreamWriteEnd::Restored => Ok(()),
        StreamWriteEnd::Abort {
            export,
            error,
            destination,
        } => {
            let destination_handle = export.destination;
            export.encoder.abort();
            match destination {
                DestinationAfterFailedWrite::Release => {
                    let _ = release_destination(&state.export_destinations, &destination_handle);
                }
                DestinationAfterFailedWrite::Retire => {
                    let _ = remove_destination(
                        &state.export_destinations,
                        &destination_handle,
                        &[ExportDestinationState::Writing],
                    );
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn finish_export_rawvideo_stream(
    state: State<'_, AppState>,
    handle: String,
) -> AppResult<()> {
    let handle = normalize_export_stream_handle(&handle)?;
    let export = take_ready_stream(&state.rawvideo_exports, &handle, "rawvideo")?;
    let destination = export.destination;
    let result = tauri::async_runtime::spawn_blocking(move || export.encoder.finish())
        .await
        .unwrap_or_else(|e| {
            Err(AppError::Other(format!(
                "rawvideo export finish task failed: {e}"
            )))
        });
    if result.is_ok() {
        mark_destination_ready(&state.export_destinations, &destination)?;
    } else {
        let _ = release_destination(&state.export_destinations, &destination);
    }
    result.map(|_| ())
}

#[tauri::command(async)]
pub fn abort_export_rawvideo_stream(
    state: State<AppState>,
    handle: String,
    reason: String,
) -> AppResult<()> {
    let handle = normalize_export_stream_handle(&handle)?;
    if let Some(export) = take_or_cancel_stream(&state.rawvideo_exports, &handle) {
        tracing::error!(%handle, %reason, "rawvideo export aborted");
        export.encoder.abort();
        release_destination(&state.export_destinations, &export.destination)?;
    }
    Ok(())
}

/// Retire a completed destination and reveal it in the platform file manager.
#[tauri::command(async)]
pub fn complete_export(
    app: AppHandle,
    state: State<AppState>,
    destination: String,
) -> AppResult<()> {
    let path = remove_destination(
        &state.export_destinations,
        &destination,
        &[ExportDestinationState::Ready],
    )?;
    if let Err(error) = app.opener().reveal_item_in_dir(&path) {
        tracing::warn!(%error, "failed to reveal completed export");
    }
    Ok(())
}

/// Retire a cancelled or otherwise unused destination without touching its file.
#[tauri::command(async)]
pub fn discard_export_destination(state: State<AppState>, destination: String) -> AppResult<()> {
    remove_destination(
        &state.export_destinations,
        &destination,
        &[
            ExportDestinationState::Available,
            ExportDestinationState::Ready,
        ],
    )?;
    Ok(())
}

fn remove_destination(
    destinations: &parking_lot::Mutex<std::collections::HashMap<String, ExportDestination>>,
    handle: &str,
    allowed: &[ExportDestinationState],
) -> AppResult<PathBuf> {
    let mut destinations = destinations.lock();
    let destination = destinations
        .get(handle)
        .ok_or_else(|| AppError::Other("unknown export destination handle".into()))?;
    if !allowed.contains(&destination.state) {
        return Err(AppError::Other("export destination is still in use".into()));
    }
    Ok(destinations
        .remove(handle)
        .expect("destination existed while its map was locked")
        .path)
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

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0u64;
    let ok =
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None).is_ok() };
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

        finish_export_blocking(sink).unwrap();
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

    fn destinations(
        handle: &str,
        path: PathBuf,
    ) -> parking_lot::Mutex<std::collections::HashMap<String, ExportDestination>> {
        let destinations = parking_lot::Mutex::new(std::collections::HashMap::new());
        reserve_destination(&destinations, handle.to_owned(), path).unwrap();
        destinations
    }

    #[test]
    fn unselected_destination_is_rejected_without_touching_bystander() {
        let dir = std::env::temp_dir().join(format!(
            "capptivo-export-authority-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let selected = dir.join("selected.mp4");
        let bystander = dir.join("bystander.txt");
        std::fs::write(&bystander, b"keep-me").unwrap();
        let destinations = destinations("selected", selected);

        assert!(claim_available_destination(&destinations, "unselected").is_err());
        assert_eq!(std::fs::read(&bystander).unwrap(), b"keep-me");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn destination_lifecycle_allows_abort_retry_then_retires() {
        let path = PathBuf::from("/tmp/out.mp4");
        let destinations = destinations("chosen", path.clone());

        assert_eq!(
            claim_available_destination(&destinations, "chosen").unwrap(),
            path
        );
        assert!(claim_available_destination(&destinations, "chosen").is_err());
        release_destination(&destinations, "chosen").unwrap();
        claim_available_destination(&destinations, "chosen").unwrap();
        mark_destination_ready(&destinations, "chosen").unwrap();
        claim_ready_destination(&destinations, "chosen").unwrap();
        assert!(
            remove_destination(&destinations, "chosen", &[ExportDestinationState::Ready]).is_err()
        );
        finish_destination_processing(&destinations, "chosen").unwrap();
        assert_eq!(
            remove_destination(&destinations, "chosen", &[ExportDestinationState::Ready]).unwrap(),
            path
        );
        assert!(claim_available_destination(&destinations, "chosen").is_err());
    }

    #[test]
    fn duplicate_destination_path_is_reserved_until_retired() {
        let dir = std::env::temp_dir().join(format!(
            "capptivo-export-reservation-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.mp4");
        let destinations = destinations("first", path.clone());

        assert!(reserve_destination(&destinations, "second".into(), path.clone()).is_err());
        remove_destination(&destinations, "first", &[ExportDestinationState::Available]).unwrap();
        reserve_destination(&destinations, "second".into(), path).unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn destination_cannot_alias_an_active_export_partial() {
        let dir = std::env::temp_dir().join(format!(
            "capptivo-export-partial-reservation-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let first = dir.join("out.mp4");
        let destinations = destinations("first", first.clone());

        assert!(
            reserve_destination(&destinations, "second".into(), export_temp_path(&first),).is_err()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn case_variant_destination_path_is_reserved() {
        let dir = std::env::temp_dir().join(format!(
            "capptivo-export-case-reservation-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let destinations = destinations("first", dir.join("Out.mp4"));

        assert!(reserve_destination(&destinations, "second".into(), dir.join("out.mp4")).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn suggested_filename_rejects_path_authority() {
        for name in [
            "",
            ".",
            "..",
            "../out.mp4",
            "dir/out.mp4",
            "dir\\out.mp4",
            "C:out.mp4",
        ] {
            assert!(validate_suggested_name(name).is_err(), "accepted {name:?}");
        }
        validate_suggested_name("recording.mp4").unwrap();
    }

    #[test]
    fn project_audio_source_rejects_path_and_stream_authority() {
        for name in [
            "",
            ".",
            "..",
            "../screen.mp4",
            "dir/screen.mp4",
            "dir\\screen.mp4",
            "C:screen.mp4",
            "screen.mp4:stream",
        ] {
            assert!(
                validate_project_file_name(name).is_err(),
                "accepted {name:?}"
            );
        }
        validate_project_file_name("screen.mp4").unwrap();
    }

    #[test]
    fn export_stream_handles_are_opaque_and_unpredictable() {
        let first = new_export_stream_handle();
        let second = new_export_stream_handle();

        assert_ne!(first, second);
        assert_eq!(normalize_export_stream_handle(&first).unwrap(), first);
        assert_eq!(normalize_export_stream_handle(&second).unwrap(), second);
        assert!(normalize_export_stream_handle("1").is_err());
    }

    #[test]
    fn stream_write_placeholder_carries_cancellation_until_writer_returns() {
        let exports = parking_lot::Mutex::new(std::collections::HashMap::<
            String,
            StreamExportSlot<()>,
        >::new());
        let handle = "stream-7".to_owned();
        exports.lock().insert(
            handle.clone(),
            StreamExportSlot::Writing {
                destination: "chosen".into(),
                cancel_requested: false,
            },
        );

        assert!(take_or_cancel_stream(&exports, &handle).is_none());
        match finish_stream_write(&exports, handle, (), Ok(()), "h264") {
            StreamWriteEnd::Abort {
                destination: DestinationAfterFailedWrite::Retire,
                ..
            } => {}
            _ => panic!("cancelled h264 write was not retired"),
        }
        assert!(exports.lock().is_empty());
    }

    #[test]
    fn successful_stream_write_restores_ready_slot_atomically() {
        let exports = parking_lot::Mutex::new(std::collections::HashMap::<
            String,
            StreamExportSlot<()>,
        >::new());
        let handle = "stream-11".to_owned();
        exports.lock().insert(
            handle.clone(),
            StreamExportSlot::Writing {
                destination: "chosen".into(),
                cancel_requested: false,
            },
        );

        assert!(matches!(
            finish_stream_write(&exports, handle.clone(), (), Ok(()), "test"),
            StreamWriteEnd::Restored
        ));
        assert!(take_or_cancel_stream(&exports, &handle).is_some());
        assert!(exports.lock().is_empty());
    }

    #[test]
    fn premature_finish_preserves_write_placeholder() {
        let exports = parking_lot::Mutex::new(std::collections::HashMap::<
            String,
            StreamExportSlot<()>,
        >::new());
        let handle = "stream-13".to_owned();
        exports.lock().insert(
            handle.clone(),
            StreamExportSlot::Writing {
                destination: "chosen".into(),
                cancel_requested: false,
            },
        );

        assert!(take_ready_stream(&exports, &handle, "test").is_err());
        assert!(take_or_cancel_stream(&exports, &handle).is_none());
        match finish_stream_write(&exports, handle, (), Ok(()), "test") {
            StreamWriteEnd::Abort {
                destination: DestinationAfterFailedWrite::Retire,
                ..
            } => {}
            _ => panic!("premature finish lost the later cancellation"),
        }
    }
}

//! Recording commands — thin adapters over [`RecorderController`] and the project
//! store. No pipeline logic lives here (§5).

use crate::error::{AppError, AppResult};
use crate::permissions::PermissionStatus;
use crate::recorder::types::{CaptureAreaSelection, CaptureDevice, CaptureSource, RecorderConfig, RecorderState};
use crate::state::{AppState, CurrentProject, ExportSink};
use crate::windows;
use std::io::Write;
use tauri::{AppHandle, Emitter, Manager, State};

/// `(async)` — the body screenshots every display and window (see
/// `backend/source_preview.rs`); on the main thread that freezes every
/// Capptivo window. Same rule as [`write_camera_chunk`].
#[tauri::command(async)]
pub fn list_capture_sources(
    state: State<AppState>,
    include_thumbnails: bool,
) -> AppResult<Vec<CaptureSource>> {
    state.recorder.list_sources(include_thumbnails)
}

/// `(async)` — enumerates AVFoundation / media devices; polled while the
/// Device menu is open. Same rule as [`write_camera_chunk`].
#[tauri::command(async)]
pub fn list_capture_devices(state: State<AppState>) -> AppResult<Vec<CaptureDevice>> {
    state.recorder.list_devices()
}

/// `(async)` — cheap on its own, but it is awaited on the launch path
/// immediately before [`request_screen_permission`]; splitting the two across
/// thread policies would only make the pair harder to reason about.
#[tauri::command(async)]
pub fn check_permissions(state: State<AppState>) -> PermissionStatus {
    PermissionStatus::from_screen(state.recorder.has_permission())
}

/// `(async)` — drives the OS permission flow (macOS TCC), which blocks until
/// the platform answers. Same rule as [`write_camera_chunk`].
#[tauri::command(async)]
pub fn request_screen_permission(state: State<AppState>) -> PermissionStatus {
    let granted = state.recorder.request_permission();
    PermissionStatus::from_screen(granted)
}

/// Open the OS settings page for screen recording (macOS TCC; no-op elsewhere —
/// the UI hides the button via `platform_capabilities`).
#[tauri::command]
pub fn open_screen_recording_settings(app: AppHandle) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let Some(url) = crate::permissions::screen_recording_settings_url() else {
        return Ok(());
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::Other(e.to_string()))
}

/// What this build/OS can do — read once by the frontend to feature-gate UI.
#[tauri::command]
pub fn platform_capabilities() -> crate::capabilities::PlatformCapabilities {
    crate::capabilities::PlatformCapabilities::current()
}

/// Relaunch the app (used after a permission grant that needs a restart).
#[tauri::command]
pub fn relaunch(app: AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn recorder_state(state: State<AppState>) -> RecorderState {
    state.recorder.state()
}

/// `(async)` — the body creates the project directory, writes and fsyncs the
/// recording stub, and brings the whole capture pipeline up (~330 ms; see the
/// `starting` state in `src/windows/recorder/RecorderApp.tsx`). On the main
/// thread that is a visible freeze of every window right as the countdown ends.
///
/// The post-start chrome calls are safe off-main: `set_capture_exclusion` is an
/// empty no-op on macOS (`windows.rs`) and its Windows arm is already invoked
/// off-main by [`stop_recording`], which is an `async fn`; the `emit_*` calls
/// are Tauri events, which are thread-safe by construction.
/// `(async)` — raises/unminimizes a window source during the countdown so the
/// user sees what will be recorded before capture starts.
#[tauri::command(async)]
pub fn prepare_window_capture(source_id: String) -> AppResult<()> {
    #[cfg(all(target_os = "macos", feature = "scap-capture"))]
    {
        if let Some(window_id) = crate::recorder::backend::picker_sources::parse_window_id(&source_id)
        {
            return crate::recorder::backend::prepare_for_capture(window_id);
        }
    }
    let _ = source_id;
    Ok(())
}

#[tauri::command(async)]
pub fn start_recording(
    app: AppHandle,
    state: State<AppState>,
    config: RecorderConfig,
) -> AppResult<()> {
    if state.current_project.lock().is_some() {
        return Err(AppError::Busy("recording".into()));
    }

    prepare_window_capture(config.source_id.clone())?;

    let (id, dir) = state.store.create()?;
    state.store.write_recording_stub(&id, &config)?;

    match state.recorder.start(&config, &dir) {
        Ok(()) => {
            let capture_microphone = config.capture_microphone;
            *state.current_project.lock() = Some(CurrentProject {
                id: id.clone(),
                config,
            });
            // Keep overlay chrome (HUD, face-cam) out of the recorded frames.
            // macOS handles this inside the backend (SCK excluded_targets);
            // Windows opts our windows out via WDA_EXCLUDEFROMCAPTURE.
            windows::set_capture_exclusion(&app, true);
            // Face-cam bubble stays put; it re-acquires the camera after SCK is live.
            if app.get_webview_window(windows::CAMERA_LABEL).is_some() {
                windows::emit_camera_capture_start(&app, &id);
            }
            if capture_microphone {
                windows::emit_mic_capture_start(&app, &id);
            }
            Ok(())
        }
        Err(e) => {
            let _ = state.store.delete(&id);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn pause_recording(state: State<AppState>) -> AppResult<()> {
    state.recorder.pause()
}

#[tauri::command]
pub fn resume_recording(state: State<AppState>) -> AppResult<()> {
    state.recorder.resume()
}

/// Open a camera file sink under the current project (`camera.webm` / `camera.mp4`).
///
/// `(async)` — see [`write_camera_chunk`] for why this family stays off the
/// app's main thread.
#[tauri::command(async)]
pub fn begin_camera_file(
    state: State<AppState>,
    project_id: String,
    filename: String,
) -> AppResult<()> {
    if filename != "camera.webm" && filename != "camera.mp4" {
        return Err(AppError::Other("invalid camera filename".into()));
    }
    {
        let current = state.current_project.lock();
        let Some(cur) = current.as_ref() else {
            return Err(AppError::NotRecording);
        };
        if cur.id != project_id {
            return Err(AppError::Other("camera project mismatch".into()));
        }
    }
    let path = state.store.project_dir(&project_id)?.join(&filename);
    let file = std::fs::File::create(&path)?;
    *state.camera_sink.lock() = Some(ExportSink {
        file,
        path,
        final_path: None,
    });
    Ok(())
}

/// Append the request's raw body to the open camera file. The chunk is the
/// *entire* invoke payload because that is the only shape Tauri transfers as
/// `application/octet-stream` — a `Uint8Array` nested in an object is
/// JSON-encoded as one decimal number per byte.
///
/// `(async)` runs the body on the Tauri worker pool. A `#[tauri::command]` that
/// is neither `async fn` nor marked `(async)` executes *inline on the app's main
/// thread*, and one `write_all` per MediaRecorder timeslice on that thread is
/// jank the user sees **while recording**.
///
/// Chunk order survives the move because the caller serializes it:
/// `src/windows/camera/cameraCapture.ts` chains every write through a single
/// `writeChain` promise, so the next invoke is never issued until the previous
/// one has resolved. That chain is load-bearing for a different reason too
/// (`Blob.arrayBuffer()` is async), and its comment says so — if it ever goes
/// away, this command must go back to being synchronous.
#[tauri::command(async)]
pub fn write_camera_chunk(
    state: State<AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let tauri::ipc::InvokeBody::Raw(chunk) = request.body() else {
        return Err(AppError::Other(
            "write_camera_chunk expects a raw byte body".into(),
        ));
    };
    let mut sink = state.camera_sink.lock();
    let sink = sink
        .as_mut()
        .ok_or_else(|| AppError::Other("no open camera file".into()))?;
    sink.file.write_all(chunk)?;
    Ok(())
}

#[tauri::command]
pub async fn finish_camera_file(state: State<'_, AppState>) -> AppResult<Option<String>> {
    // Take the sink out under the lock and drop the guard before awaiting — a
    // `parking_lot` guard is not `Send` and must not cross the await.
    let Some(sink) = state.camera_sink.lock().take() else {
        return Ok(None);
    };

    tauri::async_runtime::spawn_blocking(move || {
        sink.file.sync_all()?;
        let name = sink
            .path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("camera.webm")
            .to_string();
        Ok(Some(name))
    })
    .await
    .map_err(|e| AppError::Other(format!("camera finish task failed: {e}")))?
}

#[tauri::command(async)]
pub fn begin_mic_file(
    state: State<AppState>,
    project_id: String,
    filename: String,
) -> AppResult<()> {
    if filename != "mic.webm" {
        return Err(AppError::Other("invalid mic filename".into()));
    }
    {
        let current = state.current_project.lock();
        let Some(cur) = current.as_ref() else {
            return Err(AppError::NotRecording);
        };
        if cur.id != project_id {
            return Err(AppError::Other("mic project mismatch".into()));
        }
    }
    let path = state.store.project_dir(&project_id)?.join(&filename);
    let file = std::fs::File::create(&path)?;
    *state.mic_sink.lock() = Some(ExportSink {
        file,
        path,
        final_path: None,
    });
    Ok(())
}

/// Append the request's raw body to the open mic file. Same raw-payload rule as
/// [`write_camera_chunk`] — append-only, no headers.
///
/// `(async)` for the same reason, and safe for the same reason:
/// `src/windows/recorder/micCapture.ts` serializes these writes through its own
/// `writeChain`, so they cannot land out of order.
#[tauri::command(async)]
pub fn write_mic_chunk(
    state: State<AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<()> {
    let tauri::ipc::InvokeBody::Raw(chunk) = request.body() else {
        return Err(AppError::Other(
            "write_mic_chunk expects a raw byte body".into(),
        ));
    };
    let mut sink = state.mic_sink.lock();
    let sink = sink
        .as_mut()
        .ok_or_else(|| AppError::Other("no open mic file".into()))?;
    sink.file.write_all(chunk)?;
    Ok(())
}

/// Close the narration sink, returning its file name. Same fsync-on-the-blocking-pool
/// reasoning as [`finish_camera_file`].
#[tauri::command]
pub async fn finish_mic_file(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let Some(sink) = state.mic_sink.lock().take() else {
        return Ok(None);
    };

    tauri::async_runtime::spawn_blocking(move || {
        sink.file.sync_all()?;
        let name = sink
            .path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("mic.webm")
            .to_string();
        Ok(Some(name))
    })
    .await
    .map_err(|e| AppError::Other(format!("mic finish task failed: {e}")))?
}

/// Stop capture, finalize the project on disk, open the editor, and return the
/// project id. Screen capture must finish before the editor is shown — the
/// editor is intentionally capturable (for Capptivo demos), so opening it
/// while SCK is still live would paint the shell into the last frames.
#[tauri::command]
pub async fn stop_recording(app: AppHandle, state: State<'_, AppState>) -> AppResult<String> {
    // Read, do not take. `current_project` is the only thing preventing a second
    // `start_recording` (see the `Busy` guard), so it must stay in place until
    // the capture backend has actually stopped — clearing it up front is what
    // used to leave the app believing it was idle while the HUD was still up and
    // capture exclusion still applied. Concurrent stops are still safe:
    // `RecorderController::stop` claims its own `active` atomically, so the
    // losing caller gets `NotRecording` from there.
    //
    // The guard is dropped at the end of this statement — it must not be held
    // across the `await` below.
    let current = state
        .current_project
        .lock()
        .clone()
        .ok_or(AppError::NotRecording)?;

    let project_id = current.id.clone();
    let capture_system_audio = current.config.capture_system_audio;

    // Halt ScreenCaptureKit (+ encode drain) before opening the editor. HUD /
    // camera stay excluded; the editor itself is capturable, so stop-first is
    // what keeps it out of the take's tail.
    let recorder = state.recorder.clone();
    let store = state.store.clone();

    let stopped = tauri::async_runtime::spawn_blocking(move || recorder.stop())
        .await
        .map_err(|e| AppError::Other(format!("stop task failed: {e}")));

    let (artifacts, stop_err) = match stopped {
        Ok(Ok(artifacts)) => (Some(artifacts), None),
        Ok(Err(e)) => (None, Some(e)),
        Err(e) => (None, Some(e)),
    };

    // `RecorderController::stop` has already joined the encode thread — holding
    // the session open protects nothing. Retire it on every path so a failed
    // stop never wedges `start_recording` or leaves overlays up.
    let _ = state.current_project.lock().take();
    let _ = state.camera_sink.lock().take();
    let _ = state.mic_sink.lock().take();
    let config = current.config;

    let _ = windows::restore_recorder_setup_layout(&app);
    let _ = windows::hide_recorder(app.clone());
    let _ = windows::hide_annotation_overlay(app.clone());
    let _ = windows::dismiss_camera_preview(app.clone());
    crate::area_picker::hide_area_frame_guide(&app);
    windows::set_capture_exclusion(&app, false);

    if let Some(e) = stop_err {
        tracing::error!(
            %e,
            project = %project_id,
            "stop_recording failed before artifacts"
        );
        return Err(e);
    }

    let artifacts = artifacts.expect("stop_err and artifacts are mutually exclusive");

    if let Some(e) = artifacts.error.clone() {
        tracing::error!(
            %e,
            project = %project_id,
            frames = artifacts.stats.frames_encoded,
            "recording encode failed; partial take kept on disk"
        );
        return Err(e);
    }

    let mic_path = state.store.project_dir(&project_id)?.join("mic.webm");
    if mic_path.is_file() {
        if let Err(e) = tauri::async_runtime::spawn_blocking({
            let screen = artifacts.screen_path.clone();
            let mic = mic_path.clone();
            move || crate::recorder::encoder::attach_mic_audio(&screen, &mic, capture_system_audio)
        })
        .await
        .map_err(|e| AppError::Other(format!("mic mux task failed: {e}")))?
        {
            tracing::warn!(%e, "failed to mux mic into screen.mp4");
        } else {
            let _ = std::fs::remove_file(&mic_path);
        }
    }

    // Recording is complete — remux the fragmented capture into a seekable
    // progressive MP4 (crash-safe fragmentation is only needed *during* capture).
    // Best-effort: on failure the still-playable fragmented file is left in place.
    if let Err(e) = tauri::async_runtime::spawn_blocking({
        let screen = artifacts.screen_path.clone();
        move || crate::recorder::encoder::finalize_recording_mp4(&screen)
    })
    .await
    .map_err(|e| AppError::Other(format!("finalize task failed: {e}")))?
    {
        tracing::warn!(%e, "failed to finalize screen.mp4 to a progressive MP4");
    }

    let screen_bytes = std::fs::metadata(&artifacts.screen_path)
        .ok()
        .map(|m| m.len());
    if !take_is_usable(artifacts.stats.frames_encoded, screen_bytes) {
        tracing::warn!(
            project = %project_id,
            frames = artifacts.stats.frames_encoded,
            bytes = ?screen_bytes,
            interrupted = artifacts.interrupted,
            "rejecting unusable take"
        );
        return Err(AppError::Other(
            "Nothing was recorded. Choose your source again and start a new recording.".into(),
        ));
    }

    // Capture is stopped and the take is real — safe to show the editor. Mic mux /
    // progressive remux above can still take a moment; the editor loads and waits
    // on finalized.
    if let Err(e) = windows::open_editor_window(&app, &project_id) {
        tracing::warn!(%e, "failed to open editor window");
    }

    let project = store.finalize(&project_id, &config, &artifacts)?;

    tracing::info!(
        project = %project.id,
        frames = artifacts.stats.frames_encoded,
        dropped = artifacts.stats.frames_dropped,
        secs = artifacts.stats.duration_seconds,
        "recording finalized"
    );

    let _ = app.emit("project://finalized", &project.id);

    Ok(project.id)
}

#[tauri::command]
pub async fn pick_capture_area(
    app: AppHandle,
    pick_state: State<'_, crate::area_picker::AreaPickState>,
) -> AppResult<CaptureAreaSelection> {
    crate::area_picker::pick_capture_area(app, pick_state).await
}

#[tauri::command]
pub fn complete_area_pick(
    app: AppHandle,
    pick_state: State<'_, crate::area_picker::AreaPickState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<()> {
    crate::area_picker::complete_area_pick(&app, &pick_state, x, y, width, height)
}

#[tauri::command]
pub fn cancel_area_pick(
    app: AppHandle,
    pick_state: State<'_, crate::area_picker::AreaPickState>,
) {
    crate::area_picker::cancel_area_pick(&app, &pick_state);
}

#[tauri::command]
pub fn show_area_frame_guide(
    app: AppHandle,
    selection: CaptureAreaSelection,
) -> AppResult<()> {
    crate::area_picker::show_area_frame_guide(&app, &selection)
}

#[tauri::command]
pub fn hide_area_frame_guide(app: AppHandle) {
    crate::area_picker::hide_area_frame_guide(&app);
}

/// Minimum `screen.mp4` size for a take to be considered real.
const MIN_SCREEN_BYTES: u64 = 1024;

/// Whether a stopped take has enough encoded content to open in the editor.
fn take_is_usable(frames_encoded: u64, screen_bytes: Option<u64>) -> bool {
    frames_encoded > 0 && screen_bytes.is_some_and(|b| b >= MIN_SCREEN_BYTES)
}

#[cfg(test)]
mod tests {
    use super::take_is_usable;

    #[test]
    fn take_is_usable_rejects_zero_frames() {
        assert!(!take_is_usable(0, Some(5_000)));
        assert!(!take_is_usable(0, None));
    }

    #[test]
    fn take_is_usable_rejects_tiny_file() {
        assert!(!take_is_usable(30, Some(200)));
        assert!(!take_is_usable(1, Some(super::MIN_SCREEN_BYTES - 1)));
    }

    #[test]
    fn take_is_usable_accepts_normal_take() {
        assert!(take_is_usable(900, Some(50_000)));
    }

    #[test]
    fn take_is_usable_accepts_short_real_clip() {
        // A 1-second 30fps clip with a few KB of muxed data must not be rejected.
        assert!(take_is_usable(30, Some(4_096)));
    }
}

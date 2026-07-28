//! Recording commands — thin adapters over [`RecorderController`] and the project
//! store. No pipeline logic lives here (§5).

use crate::error::{AppError, AppResult};
use crate::permissions::PermissionStatus;
use crate::recorder::types::{CaptureAreaSelection, CaptureDevice, CaptureSource, RecorderConfig, RecorderState};
use crate::state::{AppState, CurrentProject, ExportSink};
use crate::windows;
use std::io::Write;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn list_capture_sources(state: State<AppState>) -> AppResult<Vec<CaptureSource>> {
    state.recorder.list_sources()
}

#[tauri::command]
pub fn list_capture_devices(state: State<AppState>) -> AppResult<Vec<CaptureDevice>> {
    state.recorder.list_devices()
}

#[tauri::command]
pub fn check_permissions(state: State<AppState>) -> PermissionStatus {
    PermissionStatus::from_screen(state.recorder.has_permission())
}

#[tauri::command]
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

#[tauri::command]
pub fn start_recording(
    app: AppHandle,
    state: State<AppState>,
    config: RecorderConfig,
) -> AppResult<()> {
    if state.current_project.lock().is_some() {
        return Err(AppError::Busy("recording".into()));
    }

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
#[tauri::command]
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
    let path = state.store.project_dir(&project_id).join(&filename);
    let file = std::fs::File::create(&path)?;
    *state.camera_sink.lock() = Some(ExportSink { file, path });
    Ok(())
}

/// Append the request's raw body to the open camera file. The chunk is the
/// *entire* invoke payload because that is the only shape Tauri transfers as
/// `application/octet-stream` — a `Uint8Array` nested in an object is
/// JSON-encoded as one decimal number per byte.
#[tauri::command]
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
pub fn finish_camera_file(state: State<AppState>) -> AppResult<Option<String>> {
    let Some(sink) = state.camera_sink.lock().take() else {
        return Ok(None);
    };
    sink.file.sync_all()?;
    let name = sink
        .path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("camera.webm")
        .to_string();
    Ok(Some(name))
}

#[tauri::command]
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
    let path = state.store.project_dir(&project_id).join(&filename);
    let file = std::fs::File::create(&path)?;
    *state.mic_sink.lock() = Some(ExportSink { file, path });
    Ok(())
}

/// Append the request's raw body to the open mic file. Same raw-payload rule as
/// [`write_camera_chunk`] — append-only, no headers.
#[tauri::command]
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

#[tauri::command]
pub fn finish_mic_file(state: State<AppState>) -> AppResult<Option<String>> {
    let Some(sink) = state.mic_sink.lock().take() else {
        return Ok(None);
    };
    sink.file.sync_all()?;
    let name = sink
        .path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("mic.webm")
        .to_string();
    Ok(Some(name))
}

/// Stop capture, finalize the project on disk, open the editor, and return the
/// project id. Screen capture must finish before the editor is shown — the
/// editor window is not in the SCK exclusion list, so opening it first paints a
/// blank Capptivo shell into the last frames of the take.
#[tauri::command]
pub async fn stop_recording(app: AppHandle, state: State<'_, AppState>) -> AppResult<String> {
    let current = state
        .current_project
        .lock()
        .take()
        .ok_or(AppError::NotRecording)?;

    let _ = state.camera_sink.lock().take();
    let _ = state.mic_sink.lock().take();
    let project_id = current.id.clone();
    let capture_system_audio = current.config.capture_system_audio;

    // Halt ScreenCaptureKit (+ encode drain) while Capptivo chrome is still the
    // excluded HUD only. Opening the editor before this is what left a blank
    // "Capptivo Editor" window in the tail of every recording.
    let recorder = state.recorder.clone();
    let store = state.store.clone();
    let config = current.config;

    let artifacts = tauri::async_runtime::spawn_blocking(move || recorder.stop())
        .await
        .map_err(|e| AppError::Other(format!("stop task failed: {e}")))??;

    let _ = windows::hide_recorder(app.clone());
    let _ = windows::hide_annotation_overlay(app.clone());
    let _ = windows::dismiss_camera_preview(app.clone());
    crate::area_picker::hide_area_frame_guide(&app);
    windows::set_capture_exclusion(&app, false);

    // Capture is stopped — safe to show the editor. Mic mux / progressive remux
    // below can still take a moment; the editor loads and waits on finalized.
    if let Err(e) = windows::open_editor_window(&app, &project_id) {
        tracing::warn!(%e, "failed to open editor window");
    }

    let mic_path = state.store.project_dir(&project_id).join("mic.webm");
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

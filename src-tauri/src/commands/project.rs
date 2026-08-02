//! Project commands — thin adapters over [`ProjectStore`]. These back the
//! editor host and the recordings library window.

use crate::error::{AppError, AppResult};
use crate::project::{camera_track, proxy, Project, ProjectSummary};
use crate::state::AppState;
use crate::windows;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Result of [`ensure_proxy`]: the recording's true dimensions (authoritative for
/// export) plus the proxy filename when it's already available.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    /// Proxy filename when ready now; `None` while a transcode runs (a
    /// `project://proxy-ready` event fires with `{ projectId, proxy }` when done).
    pub proxy: Option<String>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyReadyEvent {
    project_id: String,
    proxy: String,
}

/// Emitted when a transcode gives up. The editor waits for the proxy rather
/// than pulling a large original across IPC, so a failure that only reached the
/// log would leave the preview blank with nothing left to wait for.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyFailedEvent {
    project_id: String,
    reason: String,
}

/// Ensure a preview proxy exists for `project_id`. Returns immediately with the
/// original dimensions (and the proxy filename if it already exists); otherwise
/// the transcode runs on a background thread and `project://proxy-ready` is
/// emitted when it lands. Concurrent calls for the same project coalesce.
#[tauri::command]
pub fn ensure_proxy(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
) -> AppResult<ProxyStatus> {
    let (width, height) = state.store.recording_size(&project_id).unwrap_or((0, 0));
    let dir = state.store.project_dir(&project_id)?;

    if proxy::path_in(&dir).is_file() {
        return Ok(ProxyStatus {
            proxy: Some(proxy::PROXY_FILE.to_string()),
            width,
            height,
        });
    }

    // Coalesce: only one transcode per project at a time.
    if !state.proxy_jobs.lock().insert(project_id.clone()) {
        return Ok(ProxyStatus {
            proxy: None,
            width,
            height,
        });
    }

    let screen = dir.join("screen.mp4");
    let app = app.clone();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(|| proxy::generate(&screen, &dir));
        // Always clear the in-flight flag — a panic in `proxy::generate` used to
        // leave `proxy_jobs` set and the editor waited forever for proxy-ready.
        if let Some(state) = app.try_state::<AppState>() {
            state.proxy_jobs.lock().remove(&project_id);
        }
        match result {
            Ok(Ok(())) => {
                let _ = app.emit(
                    "project://proxy-ready",
                    ProxyReadyEvent {
                        project_id,
                        proxy: proxy::PROXY_FILE.to_string(),
                    },
                );
            }
            Ok(Err(e)) => {
                tracing::warn!(%e, "preview proxy generation failed");
                let _ = app.emit(
                    "project://proxy-failed",
                    ProxyFailedEvent {
                        project_id,
                        reason: e.to_string(),
                    },
                );
            }
            Err(_) => {
                tracing::warn!("preview proxy generation panicked");
                let _ = app.emit(
                    "project://proxy-failed",
                    ProxyFailedEvent {
                        project_id,
                        reason: "preview proxy generation failed".into(),
                    },
                );
            }
        }
    });

    Ok(ProxyStatus {
        proxy: None,
        width,
        height,
    })
}

/// Result of [`ensure_camera_track`]: the face-cam filename to play, when one is
/// ready now.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraTrackStatus {
    /// Face-cam filename when ready now. `None` either because the project has
    /// no face-cam (`pending` is false) or because a normalization pass is
    /// running (`pending` is true, `project://camera-ready` follows).
    pub camera: Option<String>,
    pub pending: bool,
    /// Milliseconds the face-cam track is shifted against the screen timeline.
    /// The editor and the exporter must both apply it, or preview and output
    /// disagree. `None` on takes recorded before it was measured — those keep
    /// the old "assume aligned" behaviour rather than guessing a correction.
    pub offset_ms: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraReadyEvent {
    project_id: String,
    camera: String,
}

/// Emitted when normalization gives up. The editor keeps playing the recorded
/// WebM — degraded on WKWebView, but better than dropping the face-cam.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraFailedEvent {
    project_id: String,
    reason: String,
}

/// Ensure the face-cam track for `project_id` is a seekable H.264 MP4.
///
/// The camera bubble records VP9-in-WebM with no duration and no seek index;
/// see [`camera_track`] for why the editor cannot composite that file on
/// WKWebView. Returns immediately with the normalized filename when it already
/// exists, otherwise transcodes on a background thread and emits
/// `project://camera-ready`. Concurrent calls for the same project coalesce.
#[tauri::command]
pub fn ensure_camera_track(
    app: AppHandle,
    state: State<AppState>,
    project_id: String,
) -> AppResult<CameraTrackStatus> {
    let dir = state.store.project_dir(&project_id)?;
    let offset_ms = state.store.camera_offset_ms(&project_id);

    if camera_track::is_usable(&dir.join(camera_track::CAMERA_MP4)) {
        return Ok(CameraTrackStatus {
            camera: Some(camera_track::CAMERA_MP4.to_string()),
            pending: false,
            offset_ms,
        });
    }
    if !camera_track::is_usable(&dir.join(camera_track::CAMERA_WEBM)) {
        return Ok(CameraTrackStatus {
            camera: None,
            pending: false,
            offset_ms: None,
        });
    }

    // Coalesce: only one normalization per project at a time.
    if !state.camera_jobs.lock().insert(project_id.clone()) {
        return Ok(CameraTrackStatus {
            camera: None,
            pending: true,
            offset_ms,
        });
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(|| camera_track::ensure(&dir));
        // Always clear the in-flight flag, panic included — otherwise the editor
        // waits forever for a `camera-ready` that can never arrive.
        if let Some(state) = app.try_state::<AppState>() {
            state.camera_jobs.lock().remove(&project_id);
        }

        let failure = match result {
            Ok(Ok(Some(camera))) => {
                // Pin the manifest to the normalized track so later opens skip
                // straight to it instead of re-probing the directory.
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.store.set_camera_file(&project_id, camera);
                }
                let _ = app.emit(
                    "project://camera-ready",
                    CameraReadyEvent {
                        project_id,
                        camera: camera.to_string(),
                    },
                );
                return;
            }
            // The face-cam vanished between the check above and the job.
            Ok(Ok(None)) => "face-cam recording is missing".to_string(),
            Ok(Err(e)) => e.to_string(),
            Err(_) => "face-cam normalization failed".to_string(),
        };

        tracing::warn!(%failure, "face-cam track normalization failed");
        let _ = app.emit(
            "project://camera-failed",
            CameraFailedEvent {
                project_id,
                reason: failure,
            },
        );
    });

    Ok(CameraTrackStatus {
        camera: None,
        pending: true,
        offset_ms,
    })
}

#[tauri::command(async)]
pub fn list_projects(state: State<AppState>) -> AppResult<Vec<ProjectSummary>> {
    state.store.list()
}

#[tauri::command(async)]
pub fn load_project(state: State<AppState>, id: String) -> AppResult<Project> {
    state.store.load(&id)
}

#[tauri::command(async)]
pub fn save_editor_state(
    state: State<AppState>,
    id: String,
    editor_state: serde_json::Value,
) -> AppResult<()> {
    state.store.save_editor_state(&id, editor_state)
}

#[tauri::command(async)]
pub fn rename_project(state: State<AppState>, id: String, title: Option<String>) -> AppResult<()> {
    state.store.rename(&id, title)
}

/// `(async)` — `store.delete` is `fs::remove_dir_all` over a project directory
/// holding `screen.mp4` plus a proxy transcode, routinely several GB. On the
/// main thread that freezes every Capptivo window for the length of the delete.
#[tauri::command(async)]
pub fn delete_project(app: AppHandle, state: State<AppState>, id: String) -> AppResult<()> {
    // Close the editor first so it isn't left pointing at a deleted folder.
    windows::close_editor_if_open(&app, &id);
    state.store.delete(&id)
}

#[tauri::command]
pub async fn ensure_thumbnail(app: AppHandle, id: String) -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().store.ensure_thumbnail(&id))
        .await
        .map_err(|e| AppError::Other(format!("thumbnail task failed: {e}")))?
}

//! Project commands — thin adapters over [`ProjectStore`]. These back the
//! editor host and the recordings library window.

use crate::error::{AppError, AppResult};
use crate::project::{proxy, Project, ProjectSummary};
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
        let result = proxy::generate(&screen, &dir);
        // Re-fetch managed state on the thread to clear the in-flight flag.
        app.state::<AppState>().proxy_jobs.lock().remove(&project_id);
        match result {
            Ok(()) => {
                let _ = app.emit(
                    "project://proxy-ready",
                    ProxyReadyEvent {
                        project_id,
                        proxy: proxy::PROXY_FILE.to_string(),
                    },
                );
            }
            Err(e) => {
                tracing::warn!(%e, "preview proxy generation failed");
                let _ = app.emit(
                    "project://proxy-failed",
                    ProxyFailedEvent {
                        project_id,
                        reason: e.to_string(),
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

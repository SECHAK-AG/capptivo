//! Signed auto-updates from GitHub Releases (`tauri-plugin-updater`).
//!
//! Checks run off the UI thread. When an update exists we stash it and notify
//! editor/library shells via `updater://available` (Cursor-style toast) — never
//! the recorder bar. Tray / Config "Check for Updates" also surface up-to-date
//! / error status to those shells. Never install while a recording is active.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::state::AppState;
use crate::windows::{EDITOR_LABEL_PREFIX, LIBRARY_LABEL};

pub const AVAILABLE_EVENT: &str = "updater://available";
pub const STATUS_EVENT: &str = "updater://status";

/// Payload for the editor/library update toast.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAvailablePayload {
    pub version: String,
    pub current_version: String,
    pub notes: String,
}

/// Interactive-only status lines (up to date, errors, installing…).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateStatusPayload {
    Checking,
    UpToDate,
    Installing { version: String },
    /// Real download bytes — `total` is `None` when the server omits Content-Length.
    Progress {
        downloaded: u64,
        total: Option<u64>,
    },
    Error { message: String },
    BusyRecording,
}

/// IPC: tray / Config panel — always surface the outcome to a shell toast.
#[tauri::command]
pub fn check_for_updates(app: AppHandle) {
    spawn_check(app, Prompt::Interactive);
}

/// IPC: Install the stashed update (toast "Update" button).
#[tauri::command]
pub fn install_update(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_install(&app).await {
            tracing::warn!(%e, "updater install failed");
            emit_status(
                &app,
                &UpdateStatusPayload::Error {
                    message: e.clone(),
                },
            );
            // Last resort if no shell is listening.
            if !shells_open(&app) {
                notify(&app, &e, MessageDialogKind::Error);
            }
        }
    });
}

/// IPC: "Later" — drop the stashed update for this session.
#[tauri::command]
pub fn dismiss_update() {
    CANCEL_INSTALL.store(true, Ordering::SeqCst);
    if let Ok(mut slot) = PENDING.lock() {
        *slot = None;
    }
}

/// IPC: close while downloading — skip apply/restart; package is re-stashed for retry.
#[tauri::command]
pub fn cancel_install() {
    CANCEL_INSTALL.store(true, Ordering::SeqCst);
}

/// IPC: editor mount — show a toast if a quiet check finished before the shell opened.
#[tauri::command]
pub fn pending_update() -> Option<UpdateAvailablePayload> {
    PENDING
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(payload_from_update))
}

/// How to talk to the user when a check finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    /// Launch path: toast only when an update exists (and a shell is open).
    Quiet,
    /// Explicit user action: always surface the outcome.
    Interactive,
}

static CHECK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static INSTALL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
/// Set by dismiss/close — skip `install` after download finishes.
static CANCEL_INSTALL: AtomicBool = AtomicBool::new(false);

/// Stashed update waiting for Install / Later. Cleared on dismiss or install.
static PENDING: Mutex<Option<Update>> = Mutex::new(None);

/// Background check a few seconds after launch so cold start stays cold.
/// No-op in debug — unsigned/dev builds shouldn't hit production endpoints.
pub fn schedule_startup_check(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("updater-startup".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(4));
            spawn_check(app, Prompt::Quiet);
        })
        .ok();
}

/// Fire-and-forget check on Tauri's async runtime.
pub fn spawn_check(app: AppHandle, prompt: Prompt) {
    if CHECK_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if prompt == Prompt::Interactive {
            emit_status(
                &app,
                &UpdateStatusPayload::Error {
                    message: "Already checking for updates…".into(),
                },
            );
        }
        return;
    }

    if prompt == Prompt::Interactive {
        emit_status(&app, &UpdateStatusPayload::Checking);
    }

    tauri::async_runtime::spawn(async move {
        let result = run_check(&app, prompt).await;
        CHECK_IN_FLIGHT.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            tracing::warn!(%e, ?prompt, "updater check failed");
            if prompt == Prompt::Interactive {
                emit_status(
                    &app,
                    &UpdateStatusPayload::Error {
                        message: format!("Couldn't check for updates.\n{e}"),
                    },
                );
            }
        }
    });
}

async fn run_check(app: &AppHandle, prompt: Prompt) -> Result<(), String> {
    if recording_busy(app) {
        if prompt == Prompt::Interactive {
            emit_status(app, &UpdateStatusPayload::BusyRecording);
        }
        return Ok(());
    }

    let updater = app
        .updater()
        .map_err(|e| format!("updater unavailable: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    let Some(update) = update else {
        tracing::debug!("updater: already on latest");
        if let Ok(mut slot) = PENDING.lock() {
            *slot = None;
        }
        if prompt == Prompt::Interactive {
            if !emit_status(app, &UpdateStatusPayload::UpToDate) {
                notify(app, "Capptivo is up to date.", MessageDialogKind::Info);
            }
        }
        return Ok(());
    };

    tracing::info!(
        version = %update.version,
        current = %update.current_version,
        "updater: update available"
    );

    let available = payload_from_update(&update);
    if let Ok(mut slot) = PENDING.lock() {
        *slot = Some(update);
    }

    if !emit_available(app, &available) && prompt == Prompt::Interactive {
        // No editor/library yet — open the recordings list; it peeks on mount.
        if let Err(e) = crate::windows::open_library(app.clone()) {
            tracing::warn!(%e, "updater: could not open library for toast");
            notify(
                app,
                &format!(
                    "Version {} is available. Open Capptivo Library to install.",
                    available.version
                ),
                MessageDialogKind::Info,
            );
        }
    }

    Ok(())
}

async fn run_install(app: &AppHandle) -> Result<(), String> {
    if INSTALL_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Update already installing…".into());
    }
    let _guard = InstallGuard;
    CANCEL_INSTALL.store(false, Ordering::SeqCst);

    if recording_busy(app) {
        emit_status(app, &UpdateStatusPayload::BusyRecording);
        return Err("Finish or stop the current recording before updating.".into());
    }

    let update = PENDING
        .lock()
        .map_err(|_| "updater lock poisoned".to_string())?
        .take()
        .ok_or_else(|| "No update ready to install. Check for updates again.".to_string())?;

    emit_status(
        app,
        &UpdateStatusPayload::Installing {
            version: update.version.clone(),
        },
    );

    // Re-check busy right before download — user may have started recording
    // while the toast was open.
    if recording_busy(app) {
        restore_pending(update);
        emit_status(app, &UpdateStatusPayload::BusyRecording);
        return Err("Recording started — update cancelled. Try again when idle.".into());
    }

    let bytes = match update
        .download(
            {
                let app = app.clone();
                let mut downloaded: u64 = 0;
                let mut last_emit = std::time::Instant::now();
                let mut last_pct: u8 = 255;
                let mut first = true;
                move |chunk, total| {
                    downloaded = downloaded.saturating_add(chunk as u64);
                    // Throttle: ≥100ms, or a whole percent tick when total is known.
                    let pct = total.map(|t| {
                        if t == 0 {
                            0
                        } else {
                            ((downloaded.saturating_mul(100)) / t).min(100) as u8
                        }
                    });
                    let due = first
                        || last_emit.elapsed() >= Duration::from_millis(100)
                        || pct.is_some_and(|p| p != last_pct);
                    if !due {
                        return;
                    }
                    first = false;
                    last_emit = std::time::Instant::now();
                    if let Some(p) = pct {
                        last_pct = p;
                    }
                    emit_status(
                        &app,
                        &UpdateStatusPayload::Progress {
                            downloaded,
                            total,
                        },
                    );
                }
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(e) => {
            restore_pending(update);
            return Err(format!("download/install failed: {e}"));
        }
    };

    // Close/Later during download — don't apply the package or restart.
    if CANCEL_INSTALL.swap(false, Ordering::SeqCst) {
        tracing::info!("updater: install cancelled after download");
        restore_pending(update);
        return Ok(());
    }

    if let Err(e) = update.install(&bytes) {
        restore_pending(update);
        return Err(format!("download/install failed: {e}"));
    }

    tracing::info!("updater: installed; restarting");
    app.restart();
}

fn restore_pending(update: Update) {
    if let Ok(mut slot) = PENDING.lock() {
        *slot = Some(update);
    }
}

struct InstallGuard;
impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALL_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

fn payload_from_update(update: &Update) -> UpdateAvailablePayload {
    let notes = update
        .body
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("A new version of Capptivo is ready.")
        .to_string();
    UpdateAvailablePayload {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes,
    }
}

fn shells_open(app: &AppHandle) -> bool {
    app.webview_windows().into_iter().any(|(label, _)| {
        label == LIBRARY_LABEL || label.starts_with(EDITOR_LABEL_PREFIX)
    })
}

fn emit_available(app: &AppHandle, payload: &UpdateAvailablePayload) -> bool {
    emit_to_shells(app, AVAILABLE_EVENT, payload)
}

fn emit_status(app: &AppHandle, payload: &UpdateStatusPayload) -> bool {
    emit_to_shells(app, STATUS_EVENT, payload)
}

fn emit_to_shells<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: &P) -> bool {
    let mut any = false;
    for (label, win) in app.webview_windows() {
        if label == LIBRARY_LABEL || label.starts_with(EDITOR_LABEL_PREFIX) {
            let _ = win.emit(event, payload);
            any = true;
        }
    }
    any
}

fn recording_busy(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .map(|s| s.recorder.state().is_active())
        .unwrap_or(false)
}

fn notify(app: &AppHandle, message: &str, kind: MessageDialogKind) {
    app.dialog()
        .message(message.to_string())
        .title("Capptivo")
        .kind(kind)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recorder::types::RecorderState;

    #[test]
    fn prompt_variants_are_distinct() {
        assert_ne!(Prompt::Quiet, Prompt::Interactive);
    }

    #[test]
    fn busy_matches_recorder_active_states() {
        assert!(!RecorderState::Idle.is_active());
        assert!(RecorderState::Recording.is_active());
        assert!(RecorderState::Paused.is_active());
        assert!(RecorderState::Finalizing.is_active());
        assert!(!RecorderState::Error {
            message: "x".into(),
            fatal: false
        }
        .is_active());
    }

    #[test]
    fn status_payload_tags_are_stable() {
        let json = serde_json::to_value(UpdateStatusPayload::UpToDate).unwrap();
        assert_eq!(json["kind"], "upToDate");
        let json = serde_json::to_value(UpdateStatusPayload::BusyRecording).unwrap();
        assert_eq!(json["kind"], "busyRecording");
        let json = serde_json::to_value(UpdateStatusPayload::Progress {
            downloaded: 10,
            total: Some(100),
        })
        .unwrap();
        assert_eq!(json["kind"], "progress");
        assert_eq!(json["downloaded"], 10);
        assert_eq!(json["total"], 100);
    }
}

//! Signed auto-updates from GitHub Releases (`tauri-plugin-updater`).
//!
//! Checks run off the UI thread. Startup is quiet (errors / "up to date"
//! stay in the log). Tray / IPC use interactive dialogs. Never install while
//! a recording is active — that would lose an in-flight take.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;

/// IPC entry for the recorder settings menu — same path as the tray item.
#[tauri::command]
pub fn check_for_updates(app: AppHandle) {
    spawn_check(app, Prompt::Interactive);
}

/// How to talk to the user when a check finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    /// Launch path: prompt only when an update exists.
    Quiet,
    /// Explicit user action: always surface the outcome.
    Interactive,
}

/// One in-flight check at a time (startup + tray spam).
static CHECK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Background check a few seconds after launch so cold start stays cold.
/// No-op in debug — unsigned/dev builds shouldn't hit production endpoints.
pub fn schedule_startup_check(app: &AppHandle) {
    // `cfg!` keeps both arms typechecked so `Prompt::Quiet` stays live in debug.
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
            notify(&app, "Already checking for updates…", MessageDialogKind::Info);
        }
        return;
    }

    tauri::async_runtime::spawn(async move {
        let result = run_check(&app, prompt).await;
        CHECK_IN_FLIGHT.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            tracing::warn!(%e, ?prompt, "updater check failed");
            if prompt == Prompt::Interactive {
                notify(
                    &app,
                    &format!("Couldn't check for updates.\n{e}"),
                    MessageDialogKind::Error,
                );
            }
        }
    });
}

async fn run_check(app: &AppHandle, prompt: Prompt) -> Result<(), String> {
    if recording_busy(app) {
        if prompt == Prompt::Interactive {
            notify(
                app,
                "Finish or stop the current recording before updating.",
                MessageDialogKind::Warning,
            );
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
        if prompt == Prompt::Interactive {
            notify(app, "Capptivo is up to date.", MessageDialogKind::Info);
        }
        return Ok(());
    };

    tracing::info!(
        version = %update.version,
        current = %update.current_version,
        "updater: update available"
    );

    let notes = update
        .body
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("A new version of Capptivo is ready.");

    let message = format!(
        "Version {} is available (you have {}).\n\n{notes}\n\nInstall and restart now?",
        update.version, update.current_version
    );

    let app_ask = app.clone();
    let accepted = ask_install(app_ask, message).await;
    if !accepted {
        return Ok(());
    }

    // Re-check busy right before download — user may have started recording
    // while the dialog was open.
    if recording_busy(app) {
        notify(
            app,
            "Recording started — update cancelled. Try again when idle.",
            MessageDialogKind::Warning,
        );
        return Ok(());
    }

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("download/install failed: {e}"))?;

    tracing::info!("updater: installed; restarting");
    app.restart();
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

/// Native Install / Later dialog without blocking an async worker forever.
async fn ask_install(app: AppHandle, message: String) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(message)
        .title("Update Available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".into(),
            "Later".into(),
        ))
        .show(move |accepted| {
            let _ = tx.send(accepted);
        });
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false))
        .await
        .unwrap_or(false)
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
}

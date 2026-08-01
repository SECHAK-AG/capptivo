//! Capptivo Desktop — app entry (library form; `main.rs` just calls [`run`]).
//!
//! The builder stays thin: register plugins + the `media://` protocol, build
//! state and the tray in `setup`, and register the command handler. All logic
//! lives in the domain modules, none of which import `tauri` except `commands`,
//! `state`, `tray`, `windows`, and this file (§14).

pub mod captions;
mod capabilities;
mod commands;
mod proc;
#[cfg(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture")
))]
mod area_picker;
#[cfg(not(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture")
)))]
mod area_picker {
    use crate::error::{AppError, AppResult};
    use crate::recorder::types::CaptureAreaSelection;
    use tauri::{AppHandle, State};

    pub struct AreaPickState;
    impl AreaPickState {
        pub fn new() -> Self {
            Self
        }
    }
    pub async fn pick_capture_area(
        _app: AppHandle,
        _pick_state: State<'_, AreaPickState>,
    ) -> AppResult<CaptureAreaSelection> {
        Err(AppError::Unsupported)
    }
    pub fn complete_area_pick(
        _app: &AppHandle,
        _pick_state: &AreaPickState,
        _x: f64,
        _y: f64,
        _width: f64,
        _height: f64,
    ) -> AppResult<()> {
        Err(AppError::Unsupported)
    }
    pub fn cancel_area_pick(_app: &AppHandle, _pick_state: &AreaPickState) {}
    pub fn show_area_frame_guide(
        _app: &AppHandle,
        _selection: &crate::recorder::types::CaptureAreaSelection,
    ) -> AppResult<()> {
        Err(AppError::Unsupported)
    }
    pub fn hide_area_frame_guide(_app: &AppHandle) {}
}
mod backgrounds;
mod cursor;
mod error;
mod media_protocol;
mod permissions;
mod project;
mod recorder;
mod state;
mod tray;
mod windows;

use state::AppState;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;
use tracing_appender::non_blocking::WorkerGuard;

/// Keeps the non-blocking file writer alive for the process lifetime.
static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// Bundle id from `tauri.conf.json` — must match Tauri's `app_log_dir`.
const LOG_BUNDLE_ID: &str = "com.capptivo.desktop";

/// Global start/stop-and-show hotkey for the recorder popover.
const RECORDER_HOTKEY: &str = "Alt+Shift+R";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // media:// — Range-capable local media (§10). Project files under
        // `projects/<id>/…`; custom backgrounds under `_backgrounds/<file>`.
        .register_uri_scheme_protocol("media", |ctx, request| {
            let app = ctx.app_handle();
            let app_data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("Capptivo"));
            media_protocol::serve(&app_data, &request)
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::build(&handle));
            app.manage(area_picker::AreaPickState::new());
            tray::build(&handle)?;
            register_global_hotkey(&handle);

            // Launch straight into the recorder — clicking the app means the
            // user wants to record, not hunt the tray icon first.
            if let Err(e) = windows::show_recorder_popover(&handle) {
                tracing::warn!(%e, "failed to open recorder on launch");
            }

            // Warm the H.264 encoder probe off the critical path.
            //
            // `hw_encoder::pick` is `OnceLock`-cached, but filling it spawns an
            // FFmpeg process that encodes two synthetic frames — ~145 ms. Left
            // lazy, that cost lands on the user's *first* recording, inside
            // `recorder.start()`, between the countdown ending and capture being
            // live. Doing it here moves it into idle startup time; every later
            // `pick()` is then a cache read. Best-effort on a detached thread:
            // it must not delay launch, and on failure `pick()` simply probes
            // lazily as before.
            std::thread::Builder::new()
                .name("encoder-probe-warm".into())
                .spawn(|| {
                    let _ = recorder::hw_encoder::pick(&recorder::encoder::ffmpeg_path());
                })
                .ok();

            // Start menubar-only; `windows::sync_dock_policy` flips to
            // Regular while a library or editor window is open (native
            // fullscreen + green expand arrows need Regular) and back
            // when the last closes.
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                windows::refresh_activation_policy(window.app_handle(), window.label());
            }
        })
        .invoke_handler(crate::command_handlers!())
        .build(tauri::generate_context!())
        .expect("error while building Capptivo Desktop")
        .run(|app, event| {
            // Dock / Finder reopen (macOS): show the recorder rather than
            // silently sitting in the menubar. No-op on other platforms.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Err(e) = windows::show_recorder_popover(app) {
                    tracing::warn!(%e, "failed to open recorder on reopen");
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}

fn register_global_hotkey(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let result = app.global_shortcut().on_shortcut(RECORDER_HOTKEY, |app, _shortcut, event| {
        // Fire once, on key-down.
        if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
            if let Err(e) = windows::toggle_recorder_popover(app) {
                tracing::warn!(%e, "hotkey: failed to toggle recorder popover");
            }
        }
    });
    if let Err(e) = result {
        tracing::warn!(%e, hotkey = RECORDER_HOTKEY, "failed to register global hotkey");
    }
}

/// OS log folder — same layout Tauri uses for `app_log_dir` / plugin-log.
pub fn production_log_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join("Library/Logs").join(LOG_BUNDLE_ID)
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join(LOG_BUNDLE_ID).join("logs")
    }
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
            })
            .unwrap_or_else(|| PathBuf::from("."));
        base.join(LOG_BUNDLE_ID).join("logs")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        std::env::temp_dir().join("capptivo-logs")
    }
}

fn init_tracing() {
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{fmt, EnvFilter};

    let dir = production_log_dir();
    let _ = std::fs::create_dir_all(&dir);

    let file_appender = tracing_appender::rolling::daily(&dir, "capptivo");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _ = LOG_GUARD.set(guard);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,desktop_lib=debug"));

    // stderr for dev; file for production (Windows has no console).
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true).with_writer(std::io::stderr))
        .with(
            fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(non_blocking),
        )
        .try_init();

    tracing::info!(dir = %dir.display(), "file logging enabled");
}

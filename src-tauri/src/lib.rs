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
use tauri::Manager;

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
        // media://<projectId>/<file> — Range-capable local media (§10).
        .register_uri_scheme_protocol("media", |ctx, request| {
            let app = ctx.app_handle();
            let projects_root = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("projects"))
                .unwrap_or_else(|_| std::env::temp_dir().join("Capptivo").join("projects"));
            media_protocol::serve(&projects_root, &request)
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::build(&handle));
            app.manage(area_picker::AreaPickState::new());
            tray::build(&handle)?;
            register_global_hotkey(&handle);

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
        .run(tauri::generate_context!())
        .expect("error while running Capptivo Desktop");
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

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,desktop_lib=debug"));
    // `try_init` so tests / repeated inits don't panic.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}

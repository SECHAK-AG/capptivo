//! The macOS menubar tray (`NSStatusItem`). Left-click toggles the recorder
//! popover; right-click shows a native menu.
//!
//! macOS uses a dedicated monochrome Capptivo glyph as a template image (tints
//! with the menubar). Windows keeps the full-color app icon.

use crate::windows;
#[cfg(target_os = "macos")]
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

pub const TRAY_ID: &str = "capptivo-tray";

/// Flat mark for NSStatusItem — black + alpha only (`icon_as_template`).
#[cfg(target_os = "macos")]
const TRAY_TEMPLATE_PNG: &[u8] = include_bytes!("../icons/tray-template@2x.png");

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    // "Open Recorder" first: on most Linux DEs (appindicator) tray left-click
    // never fires, so the popover must be reachable from the menu. It's also a
    // discoverable fallback on Windows for users who expect click = menu.
    let open_recorder =
        MenuItem::with_id(app, "open_recorder", "Open Recorder", true, None::<&str>)?;
    let open_library = MenuItem::with_id(app, "open_library", "Recordings…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Capptivo", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_recorder, &open_library, &settings, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // Left-click drives the popover ourselves; the menu is right-click only.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event);

    builder = apply_tray_icon(app, builder)?;
    builder.build(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_tray_icon(
    _app: &AppHandle,
    builder: TrayIconBuilder<tauri::Wry>,
) -> tauri::Result<TrayIconBuilder<tauri::Wry>> {
    let icon = Image::from_bytes(TRAY_TEMPLATE_PNG)?;
    Ok(builder.icon(icon).icon_as_template(true))
}

#[cfg(not(target_os = "macos"))]
fn apply_tray_icon(
    app: &AppHandle,
    mut builder: TrayIconBuilder<tauri::Wry>,
) -> tauri::Result<TrayIconBuilder<tauri::Wry>> {
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    Ok(builder)
}

fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        "quit" => app.exit(0),
        "open_recorder" => {
            if let Err(e) = windows::toggle_recorder_popover(app) {
                tracing::warn!(%e, "failed to open recorder popover from menu");
            }
        }
        "open_library" => {
            if let Err(e) = windows::open_library(app.clone()) {
                tracing::warn!(%e, "failed to open recordings library");
            }
        }
        "settings" => {
            // Settings window is a Phase 5 item; open the popover for now.
            let _ = windows::toggle_recorder_popover(app);
        }
        other => tracing::debug!(id = other, "unhandled tray menu item"),
    }
}

fn on_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        if let Err(e) = windows::toggle_recorder_popover(tray.app_handle()) {
            tracing::warn!(%e, "failed to toggle recorder popover");
        }
    }
}

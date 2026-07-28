//! Filtered display/window enumeration for the recorder picker.
//!
//! Uses `SCShareableContent` with Apple's recommended flags (exclude desktop
//! chrome, on-screen only) plus layer-0 / min-size guards. scap's raw list
//! includes Menubar, wallpaper backdrops, and other non-recordable surfaces.

use crate::error::{AppError, AppResult};
use screencapturekit_sys::shareable_content::{UnsafeSCShareableContent, UnsafeSCWindow};

/// `kCGNormalWindowLevel` — real app windows. Dock/menubar/wallpaper sit higher.
const NORMAL_WINDOW_LAYER: u32 = 0;
const MIN_WINDOW_SIDE: f64 = 96.0;

/// Process-owned surfaces we never want in the picker.
const BLOCKED_OWNER_BUNDLES: &[&str] = &[
    "com.apple.dock",
    "com.apple.WindowManager",
    "com.apple.controlcenter",
    "com.apple.notificationcenterui",
    "com.apple.systemuiserver",
];

pub struct PickerWindow {
    pub id: u32,
    pub title: String,
}

/// Windows a user would reasonably record — not desktop chrome or our own UI.
pub fn recordable_windows() -> AppResult<Vec<PickerWindow>> {
    let content = shareable_content()?;
    let own_pid = std::process::id() as i32;
    let mut windows: Vec<PickerWindow> = content
        .windows()
        .iter()
        .filter(|w| is_recordable_window(w, own_pid))
        .map(|w| PickerWindow {
            id: w.get_window_id(),
            title: window_label(w),
        })
        .collect();

    windows.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    windows.dedup_by_key(|w| w.id);
    Ok(windows)
}

/// Frame of a shareable window in global points (the same coordinate space as
/// `CGEvent::location`), for cursor-sample normalization during window capture.
pub fn window_frame(window_id: u32) -> Option<crate::cursor::CaptureRect> {
    let content = shareable_content().ok()?;
    content
        .windows()
        .iter()
        .find(|w| w.get_window_id() == window_id)
        .map(|w| {
            let f = w.get_frame();
            crate::cursor::CaptureRect {
                x: f.origin.x,
                y: f.origin.y,
                width: f.size.width,
                height: f.size.height,
            }
        })
}

fn shareable_content() -> AppResult<objc_id::Id<UnsafeSCShareableContent>> {
    UnsafeSCShareableContent::get()
        .map_err(|e| AppError::Other(format!("failed to list capture sources: {e}")))
}

fn is_recordable_window(w: &UnsafeSCWindow, own_pid: i32) -> bool {
    if w.get_is_on_screen() == 0 {
        return false;
    }
    if w.get_window_layer() != NORMAL_WINDOW_LAYER {
        return false;
    }

    let frame = w.get_frame();
    if frame.size.width < MIN_WINDOW_SIDE || frame.size.height < MIN_WINDOW_SIDE {
        return false;
    }

    let title = w.get_title().unwrap_or_default();
    if title.trim().is_empty() || is_system_chrome_title(&title) {
        return false;
    }

    let Some(owner) = w.get_owning_application() else {
        return false;
    };
    if owner.get_process_id() == own_pid {
        return false;
    }
    if let Some(bundle) = owner.get_bundle_identifier() {
        if BLOCKED_OWNER_BUNDLES.iter().any(|b| b == &bundle) {
            return false;
        }
    }

    true
}

fn window_label(w: &UnsafeSCWindow) -> String {
    let title = w.get_title().unwrap_or_default();
    let app = w
        .get_owning_application()
        .and_then(|o| o.get_application_name())
        .unwrap_or_default();
    if app.is_empty() || title.contains(&app) {
        title
    } else {
        format!("{app} — {title}")
    }
}

fn is_system_chrome_title(title: &str) -> bool {
    matches!(
        title,
        "Menubar"
            | "Fullscreen Backdrop"
            | "Wallpaper"
            | "Dock"
            | "Status Bar"
            | "Notification Center"
    ) || title.starts_with("Item-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_known_system_titles() {
        assert!(is_system_chrome_title("Menubar"));
        assert!(is_system_chrome_title("Fullscreen Backdrop"));
        assert!(is_system_chrome_title("Item-0"));
        assert!(!is_system_chrome_title("Notes — My doc"));
    }
}

//! Filtered display/window enumeration for the recorder picker.
//!
//! Uses `SCShareableContent` with bundle/title guards to drop desktop chrome
//! (Dock, menubar, wallpaper). Normal and native-fullscreen app windows are
//! kept — fullscreen uses a non-zero window layer, so a strict layer-0-only
//! rule hid them from the picker.

use crate::cursor::CaptureRect;
use crate::error::{AppError, AppResult};
use core_graphics::display::CGDisplay;
use screencapturekit_sys::shareable_content::{UnsafeSCShareableContent, UnsafeSCDisplay, UnsafeSCWindow};
use objc_id::ShareId;

/// `kCGDockWindowLevel` — layers at/above this are Dock, menubar, etc.
const DOCK_WINDOW_LAYER: u32 = 20;
const MIN_WINDOW_SIDE: f64 = 96.0;
/// Off-current-Space windows (fullscreen on another display) can report
/// `isOnScreen == false`; require a substantial frame so minimized thumbs
/// don't appear in the list.
const OFFSPACE_MIN_SIDE: f64 = 400.0;

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

pub fn parse_window_id(source_id: &str) -> Option<u32> {
    source_id.strip_prefix("window:")?.parse().ok()
}

/// Display with the largest overlap against `rect` (global points).
pub fn display_for_rect(rect: &CaptureRect) -> Option<u32> {
    let mut best: Option<(u32, f64)> = None;
    let displays = list_displays().ok()?;
    for (id, _) in displays {
        let b = CGDisplay::new(id).bounds();
        let overlap = rect_overlap(
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            b.origin.x,
            b.origin.y,
            b.size.width,
            b.size.height,
        );
        if overlap > 0.0 {
            let prev = best.map(|(_, o)| o).unwrap_or(0.0);
            if overlap > prev {
                best = Some((id, overlap));
            }
        }
    }
    best.map(|(id, _)| id)
}

/// Integer backing scale for a display (matches `scaleFactor(for:)`).
pub fn display_scale_factor(display_id: u32) -> u32 {
    let cg = CGDisplay::new(display_id);
    cg.display_mode()
        .map(|m| {
            let w = m.width().max(1) as u64;
            (m.pixel_width() / w).max(1) as u32
        })
        .unwrap_or(1)
}

/// Points → even pixel dimensions (truncate like `Int(frame) * scale`).
pub fn points_to_even_pixels(width_pts: f64, height_pts: f64, scale: u32) -> (u32, u32) {
    let mut w = (width_pts as u32).saturating_mul(scale).max(2);
    let mut h = (height_pts as u32).saturating_mul(scale).max(2);
    w &= !1;
    h &= !1;
    (w.max(2), h.max(2))
}

/// Display that contains or intersects a window frame.
pub fn display_for_window_frame(
    frame: &CaptureRect,
    displays: &[ShareId<UnsafeSCDisplay>],
) -> Option<u32> {
    let mut best: Option<(u32, f64)> = None;
    for d in displays {
        let b = d.get_frame();
        let overlap = rect_overlap(
            frame.x,
            frame.y,
            frame.width,
            frame.height,
            b.origin.x,
            b.origin.y,
            b.size.width,
            b.size.height,
        );
        let contains_mid = frame.width > 0.0
            && frame.height > 0.0
            && b.origin.x <= frame.x + frame.width * 0.5
            && b.origin.x + b.size.width >= frame.x + frame.width * 0.5
            && b.origin.y <= frame.y + frame.height * 0.5
            && b.origin.y + b.size.height >= frame.y + frame.height * 0.5;
        if overlap > 0.0 || contains_mid {
            let score = if contains_mid {
                overlap + 1.0
            } else {
                overlap
            };
            let prev = best.map(|(_, o)| o).unwrap_or(0.0);
            if score > prev {
                best = Some((d.get_display_id(), score));
            }
        }
    }
    best.map(|(id, _)| id).or_else(|| display_for_rect(frame))
}

/// Pixel dimensions for a window at the display's backing scale (picker estimate).
pub fn window_pixel_size(window_id: u32) -> Option<(u32, u32)> {
    let content = shareable_content().ok()?;
    let window = content.windows().into_iter().find(|w| w.get_window_id() == window_id)?;
    let displays = content.displays();
    let frame = window.get_frame();
    let rect = CaptureRect {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    };
    let display_id = display_for_window_frame(&rect, &displays)?;
    let scale = display_scale_factor(display_id);
    Some(points_to_even_pixels(rect.width, rect.height, scale))
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

/// Display ids for the picker — does not use scap's panicking `get_all_targets`.
pub fn list_displays() -> AppResult<Vec<(u32, String)>> {
    let content = shareable_content()?;
    Ok(content
        .displays()
        .iter()
        .map(|d| {
            let id = d.get_display_id();
            (id, format!("Display {id}"))
        })
        .collect())
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

/// Whether `window_id` is in SCK's on-screen shareable set (capture-ready).
pub fn is_in_on_screen_set(window_id: u32) -> AppResult<bool> {
    Ok(shareable_content_on_screen()?
        .windows()
        .iter()
        .any(|w| w.get_window_id() == window_id))
}

fn shareable_content() -> AppResult<objc_id::Id<UnsafeSCShareableContent>> {
    UnsafeSCShareableContent::get().map_err(|e| {
        if e.contains("declined TCC") || e.contains("not authorized") {
            AppError::PermissionDenied
        } else {
            AppError::Other(format!("failed to list capture sources: {e}"))
        }
    })
}

/// On-screen windows only — matches the capture-time `SCShareableContent` query.
pub fn shareable_content_on_screen() -> AppResult<objc_id::Id<UnsafeSCShareableContent>> {
    use screencapturekit_sys::shareable_content::ExcludingDesktopWindowsConfig;
    let config = ExcludingDesktopWindowsConfig::default();
    UnsafeSCShareableContent::get_with_config(&config).map_err(|e| {
        if e.contains("declined TCC") || e.contains("not authorized") {
            AppError::PermissionDenied
        } else {
            AppError::Other(format!("failed to list on-screen windows: {e}"))
        }
    })
}

fn is_recordable_window(w: &UnsafeSCWindow, own_pid: i32) -> bool {
    let frame = w.get_frame();
    let title = w.get_title().unwrap_or_default();
    let owner = w.get_owning_application();
    let owner_pid = owner.as_ref().map(|o| o.get_process_id()).unwrap_or(-1);
    let owner_bundle = owner.and_then(|o| o.get_bundle_identifier());

    window_is_recordable(WindowProbe {
        is_on_screen: w.get_is_on_screen() != 0,
        layer: w.get_window_layer(),
        width: frame.size.width,
        height: frame.size.height,
        title: &title,
        owner_pid,
        own_pid,
        owner_bundle: owner_bundle.as_deref(),
    })
}

/// Pure classification — unit-tested without ScreenCaptureKit.
#[derive(Debug, Clone, Copy)]
struct WindowProbe<'a> {
    is_on_screen: bool,
    layer: u32,
    width: f64,
    height: f64,
    title: &'a str,
    owner_pid: i32,
    own_pid: i32,
    owner_bundle: Option<&'a str>,
}

fn window_is_recordable(p: WindowProbe<'_>) -> bool {
    if p.width < MIN_WINDOW_SIDE || p.height < MIN_WINDOW_SIDE {
        return false;
    }
    if p.title.trim().is_empty() || is_system_chrome_title(p.title) {
        return false;
    }
    if p.owner_pid < 0 || p.owner_pid == p.own_pid {
        return false;
    }
    if let Some(bundle) = p.owner_bundle {
        if BLOCKED_OWNER_BUNDLES.iter().any(|b| *b == bundle) {
            return false;
        }
    }
    if !is_capturable_window_layer(p.layer) {
        return false;
    }
    if p.is_on_screen {
        return true;
    }
    // Fullscreen / other-Space windows SCK can still capture once selected.
    p.width >= OFFSPACE_MIN_SIDE && p.height >= OFFSPACE_MIN_SIDE
}

/// App windows sit below Dock (20). Fullscreen uses non-zero layers in this band.
fn is_capturable_window_layer(layer: u32) -> bool {
    layer < DOCK_WINDOW_LAYER
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

fn rect_overlap(ax: f64, ay: f64, aw: f64, ah: f64, bx: f64, by: f64, bw: f64, bh: f64) -> f64 {
    let x0 = ax.max(bx);
    let y0 = ay.max(by);
    let x1 = (ax + aw).min(bx + bw);
    let y1 = (ay + ah).min(by + bh);
    let w = (x1 - x0).max(0.0);
    let h = (y1 - y0).max(0.0);
    w * h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(title: &str) -> WindowProbe<'_> {
        WindowProbe {
            is_on_screen: true,
            layer: 0,
            width: 800.0,
            height: 600.0,
            title,
            owner_pid: 42,
            own_pid: 1,
            owner_bundle: Some("com.example.app"),
        }
    }

    #[test]
    fn drops_known_system_titles() {
        assert!(is_system_chrome_title("Menubar"));
        assert!(is_system_chrome_title("Fullscreen Backdrop"));
        assert!(is_system_chrome_title("Item-0"));
        assert!(!is_system_chrome_title("Notes — My doc"));
    }

    #[test]
    fn capturable_layers_include_fullscreen_band() {
        assert!(is_capturable_window_layer(0));
        assert!(is_capturable_window_layer(1));
        assert!(is_capturable_window_layer(19));
        assert!(!is_capturable_window_layer(20)); // Dock
        assert!(!is_capturable_window_layer(24)); // Main menu
    }

    #[test]
    fn accepts_fullscreen_layer_with_app_owner() {
        let mut p = probe("Safari");
        p.layer = 1;
        assert!(window_is_recordable(p));
    }

    #[test]
    fn rejects_dock_layer_even_with_title() {
        let mut p = probe("Safari");
        p.layer = 20;
        assert!(!window_is_recordable(p));
    }

    #[test]
    fn accepts_offspace_large_fullscreen_window() {
        let p = WindowProbe {
            is_on_screen: false,
            layer: 1,
            width: 1920.0,
            height: 1080.0,
            title: "Xcode",
            owner_pid: 42,
            own_pid: 1,
            owner_bundle: Some("com.apple.dt.Xcode"),
        };
        assert!(window_is_recordable(p));
    }

    #[test]
    fn rejects_offspace_small_window() {
        let p = WindowProbe {
            is_on_screen: false,
            layer: 0,
            width: 200.0,
            height: 200.0,
            title: "Notes",
            owner_pid: 42,
            own_pid: 1,
            owner_bundle: Some("com.apple.Notes"),
        };
        assert!(!window_is_recordable(p));
    }

    #[test]
    fn rejects_own_process_and_system_chrome() {
        let mut p = probe("Capptivo");
        p.owner_pid = p.own_pid;
        assert!(!window_is_recordable(p));

        let p = probe("Fullscreen Backdrop");
        assert!(!window_is_recordable(p));
    }

    #[test]
    fn points_to_even_pixels_truncates_and_forces_even() {
        assert_eq!(points_to_even_pixels(100.9, 50.9, 2), (200, 100));
        assert_eq!(points_to_even_pixels(801.0, 600.0, 2), (1602, 1200));
    }

    #[test]
    fn rect_overlap_picks_larger_intersection() {
        let a = rect_overlap(0.0, 0.0, 100.0, 100.0, 50.0, 50.0, 100.0, 100.0);
        let b = rect_overlap(0.0, 0.0, 100.0, 100.0, 200.0, 200.0, 10.0, 10.0);
        assert!(a > b);
        assert_eq!(rect_overlap(0.0, 0.0, 10.0, 10.0, 100.0, 100.0, 10.0, 10.0), 0.0);
    }
}

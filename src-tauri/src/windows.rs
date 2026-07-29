//! Window management: recorder popover, project library shell, and per-project
//! editor. On macOS the app runs as an `Accessory` (menubar-only, no Dock icon)
//! while idle, and switches to `Regular` when a library or project editor
//! window is open.
//!
//! Root cause of the green traffic-light "+" (instead of expand arrows):
//! AppKit only offers native fullscreen / expand arrows under `Regular`, and
//! only when the window's collection behavior includes `FullScreenPrimary`.
//! Accessory shells get the legacy zoom "+" (and Sequoia's tiling menu). Both
//! the standalone Recordings `library` window and `editor:*` windows therefore
//! flip to Regular and lock `FullScreenPrimary` at create / present time.
//!
//! Accessory→Regular + `activateIgnoringOtherApps` (Tauri `set_focus`) will
//! yank Mission Control to the primary display when any Capptivo overlay still
//! joins all Spaces with its frame on screen 1 (recorder / camera). Before that
//! flip we hide the recorder and unpin overlays; then we warp the cursor onto
//! the shell and focus once so the user's display stays active.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const RECORDER_LABEL: &str = "recorder";
pub const LIBRARY_LABEL: &str = "library";
pub const CAMERA_LABEL: &str = "camera";
pub const ANNOTATION_LABEL: &str = "annotation";
pub const EDITOR_LABEL_PREFIX: &str = "editor:";

/// Frontend listens on this channel to swap the editor shell to the recordings grid.
pub const SHOW_LIBRARY_EVENT: &str = "shell://show-library";
/// Annotation overlay shown/hidden — payload `true` on show, `false` on hide.
/// The overlay WebView is reused (show/hide, never closed), so its idle
/// cursor-poll would otherwise keep running while hidden; it gates on this.
pub const ANNOTATION_VISIBILITY_EVENT: &str = "annotation://visibility";
/// Fired when the overlay hops to another display — frontend resets bar drag offset.
pub const ANNOTATION_DISPLAY_EVENT: &str = "annotation://display";
/// Progressive dismiss while the overlay is open (panel → tool → close).
pub const ANNOTATION_ESCAPE_EVENT: &str = "annotation://escape";
const ANNOTATION_ESCAPE_HOTKEY: &str = "Escape";
/// How often the native follow loop re-checks the cursor's display.
const ANNOTATION_FOLLOW_INTERVAL: Duration = Duration::from_millis(300);
/// Camera bubble should switch `getUserMedia` to this device id.
pub const CAMERA_DEVICE_EVENT: &str = "camera://device";
/// Bubble closed (X) — recorder store clears the camera toggle.
pub const CAMERA_CLOSED_EVENT: &str = "camera://closed";
/// Start separate-track capture in the camera WebView; payload = project id.
pub const CAMERA_CAPTURE_START: &str = "camera://capture-start";
/// Flush MediaRecorder → disk before screen finalize.
pub const CAMERA_CAPTURE_FLUSH: &str = "camera://capture-flush";
#[allow(dead_code)] // mirrored in JS as `camera://capture-flushed`
pub const CAMERA_CAPTURE_FLUSHED: &str = "camera://capture-flushed";

pub const MIC_CAPTURE_START: &str = "mic://capture-start";
pub const MIC_CAPTURE_FLUSH: &str = "mic://capture-flush";
#[allow(dead_code)] // mirrored in JS as `mic://capture-flushed`
pub const MIC_CAPTURE_FLUSHED: &str = "mic://capture-flushed";

/// Last device id emitted to the camera WebView — avoid re-emitting on Record
/// (that used to reopen getUserMedia and black the preview).
static LAST_CAMERA_DEVICE: Mutex<Option<String>> = Mutex::new(None);

/// Preview size — rounded rect, not a circle. Editor controls final corner radius.
const CAMERA_W: f64 = 280.0;
const CAMERA_H: f64 = 180.0;
const CAMERA_MARGIN: f64 = 24.0;

/// Bottom-right of the primary monitor work area (above the Dock).
fn camera_default_position(app: &AppHandle) -> (f64, f64) {
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return (96.0, 96.0);
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let x = (work.position.x as f64 + work.size.width as f64) / scale - CAMERA_W - CAMERA_MARGIN;
    let y = (work.position.y as f64 + work.size.height as f64) / scale - CAMERA_H - CAMERA_MARGIN;
    (x.max(0.0), y.max(0.0))
}

/// Setup toolbar (Display / devices / Record).
/// Width comes from the webview (`set_recorder_bar_width`) so the pill never clips.
const LAYOUT_SETUP_H: f64 = 64.0;
const LAYOUT_SETUP_W_FALLBACK: f64 = 880.0;
const LAYOUT_SETUP_W_MIN: f64 = 640.0;
const LAYOUT_SETUP_W_MAX: f64 = 1200.0;
/// Setup toolbar + error toast underneath (toast used to clip to a red sliver).
const LAYOUT_ALERT_H: f64 = 120.0;
/// Toolbar + device/settings dropdown (Tauri clips to window bounds — must grow).
const LAYOUT_DROPDOWN_H: f64 = 340.0;
/// Setup + source picker (display/window cards).
const LAYOUT_MENU_H: f64 = 360.0;
/// Compact live HUD (grip + timer + pause + stop).
const LAYOUT_HUD: (f64, f64) = (400.0, 56.0);
/// Countdown badge (centered on the primary display).
/// Must stay square — a wide leftover setup width makes the digit look
/// top/bottom-cramped with huge side gaps.
const LAYOUT_COUNTDOWN: (f64, f64) = (240.0, 240.0);

/// Last measured setup-bar width (logical px). 0 = use fallback until first measure.
static SETUP_BAR_W: AtomicU32 = AtomicU32::new(0);

/// Logical outer position saved before a centered layout (countdown)
/// recenters the window — restored when returning to setup/hud/etc.
static PRE_CENTERED_POS: Mutex<Option<(f64, f64)>> = Mutex::new(None);

fn setup_bar_width() -> f64 {
    let w = SETUP_BAR_W.load(Ordering::Relaxed);
    if w == 0 {
        LAYOUT_SETUP_W_FALLBACK
    } else {
        (w as f64).clamp(LAYOUT_SETUP_W_MIN, LAYOUT_SETUP_W_MAX)
    }
}

fn centered_layout_dims(layout: &str) -> Option<(f64, f64)> {
    match layout {
        "countdown" => Some(LAYOUT_COUNTDOWN),
        _ => None,
    }
}

fn layout_size(layout: &str) -> tauri::LogicalSize<f64> {
    let (w, h) = match layout {
        "menu" => (setup_bar_width(), LAYOUT_MENU_H),
        "dropdown" => (setup_bar_width(), LAYOUT_DROPDOWN_H),
        "alert" => (setup_bar_width(), LAYOUT_ALERT_H),
        "hud" => LAYOUT_HUD,
        "countdown" => LAYOUT_COUNTDOWN,
        _ => (setup_bar_width(), LAYOUT_SETUP_H),
    };
    tauri::LogicalSize::new(w, h)
}

/// Webview reports the setup pill's content width so the native window hugs it.
#[tauri::command]
pub fn set_recorder_bar_width(app: AppHandle, width: f64) -> tauri::Result<()> {
    let w = width.ceil().clamp(LAYOUT_SETUP_W_MIN, LAYOUT_SETUP_W_MAX) as u32;
    let prev = SETUP_BAR_W.swap(w, Ordering::Relaxed);
    if prev == w {
        return Ok(());
    }
    let Some(win) = app.get_webview_window(RECORDER_LABEL) else {
        return Ok(());
    };
    // Only resize while in a setup-family layout (not hud/countdown).
    let Ok(size) = win.inner_size() else {
        return Ok(());
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let logical_h = size.height as f64 / scale;
    let setup_family = (logical_h - LAYOUT_SETUP_H).abs() < 1.0
        || (logical_h - LAYOUT_ALERT_H).abs() < 1.0
        || (logical_h - LAYOUT_DROPDOWN_H).abs() < 1.0
        || (logical_h - LAYOUT_MENU_H).abs() < 1.0;
    if !setup_family {
        return Ok(());
    }
    win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        w as f64,
        logical_h,
    )))?;
    pin_to_all_spaces_if_shown(&win);
    Ok(())
}

/// macOS Spaces / Linux workspaces: keep overlay chrome (recorder / face-cam)
/// on every desktop while visible — zero-cost OS pin, no cursor polling.
/// Windows has no equivalent API; `always_on_top` alone is the behavior there.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn set_follows_spaces(win: &tauri::WebviewWindow, follows: bool) {
    if let Err(e) = win.set_visible_on_all_workspaces(follows) {
        tracing::warn!(
            %e,
            follows,
            label = win.label(),
            "overlay: failed to set visible on all workspaces"
        );
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn set_follows_spaces(_win: &tauri::WebviewWindow, _follows: bool) {}

/// Capptivo chrome that must stay visible to the user but out of `screen.mp4`.
/// macOS solves this with SCK `excluded_targets`; Windows.Graphics.Capture
/// cannot exclude arbitrary windows, so on Windows our own overlay windows opt
/// *out* of capture via `WDA_EXCLUDEFROMCAPTURE` while a recording runs (the
/// same mechanism OBS/Zoom use). The annotation overlay is deliberately not
/// listed — ink is meant to land in the recording. No-op elsewhere.
#[cfg(target_os = "windows")]
const CAPTURE_EXCLUDED_LABELS: &[&str] = &[RECORDER_LABEL, CAMERA_LABEL];

#[cfg(target_os = "windows")]
pub fn set_capture_exclusion(app: &AppHandle, excluded: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    let affinity = if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
    for label in CAPTURE_EXCLUDED_LABELS {
        let Some(win) = app.get_webview_window(label) else {
            continue;
        };
        let Ok(hwnd) = win.hwnd() else { continue };
        let hwnd = HWND(hwnd.0 as *mut std::ffi::c_void);
        if let Err(e) = unsafe { SetWindowDisplayAffinity(hwnd, affinity) } {
            tracing::warn!(%e, label, excluded, "failed to set capture exclusion");
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_capture_exclusion(_app: &AppHandle, _excluded: bool) {}

/// Whether a recording is currently active (used to apply capture exclusion to
/// overlay windows created mid-recording, e.g. the camera bubble).
fn recording_active(app: &AppHandle) -> bool {
    app.try_state::<crate::state::AppState>()
        .map(|s| s.recorder.state().is_active())
        .unwrap_or(false)
}

fn pin_to_all_spaces_if_shown(win: &tauri::WebviewWindow) {
    if win.is_visible().unwrap_or(false) {
        set_follows_spaces(win, true);
    }
}

/// Whether the app currently has a Dock presence (`Regular`), so policy is
/// only flipped on actual transitions — repeated `setActivationPolicy` calls
/// are what AppKit punishes with Space churn.
#[cfg(target_os = "macos")]
static DOCK_REGULAR: AtomicBool = AtomicBool::new(false);

/// True when a library or project editor shell is open. Both need `Regular`
/// for native fullscreen expand arrows on the green traffic light. `except`
/// skips a window mid-destruction — Tauri may still list it when `Destroyed`
/// fires.
#[cfg(target_os = "macos")]
fn wants_dock_presence(app: &AppHandle, except: Option<&str>) -> bool {
    app.webview_windows().keys().any(|label| {
        let label = label.as_str();
        Some(label) != except
            && (label == LIBRARY_LABEL || label.starts_with(EDITOR_LABEL_PREFIX))
    })
}

/// Bits for `-[NSWindow setCollectionBehavior:]`. Keep in sync with AppKit.
#[cfg(target_os = "macos")]
mod fullscreen_bits {
    pub const PRIMARY: usize = 1 << 7;
    pub const AUXILIARY: usize = 1 << 8;
    pub const ALLOWS_TILING: usize = 1 << 11;
    pub const DISALLOWS_TILING: usize = 1 << 12;

    /// Force expand-arrow fullscreen: clear auxiliary / disallow-tiling, set
    /// primary + allows-tiling. Sequoia otherwise uses a flaky heuristic that
    /// intermittently reverts the green button to "+".
    pub fn with_native_fullscreen(existing: usize) -> usize {
        let cleared = existing & !(AUXILIARY | DISALLOWS_TILING);
        cleared | PRIMARY | ALLOWS_TILING
    }
}

/// Apply `FullScreenPrimary` on the AppKit main thread only.
/// Calling `-[NSWindow setCollectionBehavior:]` off-main aborts with
/// `Must only be used from the main thread` (seen on stop → open editor).
#[cfg(target_os = "macos")]
fn enable_native_fullscreen(win: &tauri::WebviewWindow) {
    let win = win.clone();
    let _ = win
        .clone()
        .run_on_main_thread(move || apply_native_fullscreen(&win));
}

#[cfg(target_os = "macos")]
fn apply_native_fullscreen(win: &tauri::WebviewWindow) {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};

    let Ok(ptr) = win.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    let ns_window = ptr as *mut Object;
    unsafe {
        let existing: usize = msg_send![ns_window, collectionBehavior];
        let next = fullscreen_bits::with_native_fullscreen(existing);
        if next != existing {
            let _: () = msg_send![ns_window, setCollectionBehavior: next];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn enable_native_fullscreen(_win: &tauri::WebviewWindow) {}

/// Current mouse location in global top-left coordinates (same space as Tauri
/// window positions), if CoreGraphics will give it to us.
#[cfg(target_os = "macos")]
fn mouse_location() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let loc = event.location();
    Some((loc.x, loc.y))
}

/// Warp the cursor to `point` (global top-left). Used only during the brief
/// Accessory→Regular settle so Mission Control follows the shell's display.
#[cfg(target_os = "macos")]
fn warp_mouse(x: f64, y: f64) {
    use core_graphics::display::CGDisplay;
    use core_graphics::geometry::CGPoint;

    let _ = CGDisplay::warp_mouse_cursor_position(CGPoint::new(x, y));
}

/// Hide/unpin Space-joined overlays so Accessory→Regular + activate does not
/// yank Mission Control to the primary display (recorder/camera frames often
/// live on screen 1 while the user is on screen 2/3 — see `active_monitor`).
#[cfg(target_os = "macos")]
fn prepare_shell_activation(app: &AppHandle) {
    if let Some(rec) = app.get_webview_window(RECORDER_LABEL) {
        set_follows_spaces(&rec, false);
        let _ = rec.hide();
    }
    if let Some(cam) = app.get_webview_window(CAMERA_LABEL) {
        // Stay visible if the user left the bubble open, but stop joining every
        // Space so activation cannot treat primary as "the" Capptivo Space.
        set_follows_spaces(&cam, false);
    }
    if let Some(ann) = app.get_webview_window(ANNOTATION_LABEL) {
        set_follows_spaces(&ann, false);
    }
}

#[cfg(not(target_os = "macos"))]
fn prepare_shell_activation(_app: &AppHandle) {}

/// After Accessory→Regular, keep the shell on the user's display: warp cheaply
/// off-main, then one Tauri hop to unpin + focus (Tauri marshals to main).
#[cfg(target_os = "macos")]
fn schedule_display_settle(
    win: tauri::WebviewWindow,
    pos: tauri::PhysicalPosition<i32>,
    stick: (f64, f64),
) {
    std::thread::spawn(move || {
        for gap_ms in [50_u64, 120, 250] {
            std::thread::sleep(std::time::Duration::from_millis(gap_ms));
            warp_mouse(stick.0, stick.1);
        }
        let _ = win.set_visible_on_all_workspaces(false);
        warp_mouse(stick.0, stick.1);
        let _ = win.set_position(tauri::Position::Physical(pos));
        let _ = win.set_focus();
    });
}

/// Flip between menubar-only (`Accessory`) and Dock-visible (`Regular`).
///
/// `Regular` is required for native fullscreen — Accessory apps get the legacy
/// zoom "+" on the green traffic light instead of the fullscreen arrows.
///
/// Call sites must show the target window on the user's display **before** this
/// runs, and should have called `prepare_shell_activation` so overlays cannot
/// steal the Space. After an Accessory→Regular flip we stick the cursor to the
/// pre-flip click point and focus once (repeated `set_focus` re-yanks).
#[cfg(target_os = "macos")]
fn sync_dock_policy(app: &AppHandle, focus: Option<&tauri::WebviewWindow>, except: Option<&str>) {
    let want_regular = wants_dock_presence(app, except);
    if DOCK_REGULAR.swap(want_regular, Ordering::Relaxed) == want_regular {
        if let Some(win) = focus {
            if want_regular {
                enable_native_fullscreen(win);
            }
            let _ = win.set_focus();
        }
        return;
    }

    // Stick to where the user clicked (their display). Window center alone is
    // wrong if placement raced; cursor is the ground truth for `active_monitor`.
    let stick = mouse_location();
    let restore = focus.and_then(|win| {
        let pos = win.outer_position().ok()?;
        let size = win.outer_size().ok()?;
        let center = (
            pos.x as f64 + size.width as f64 / 2.0,
            pos.y as f64 + size.height as f64 / 2.0,
        );
        Some((win.clone(), pos, stick.unwrap_or(center)))
    });

    if let Some((win, _, _)) = restore.as_ref().filter(|_| want_regular) {
        // Survive the brief primary-Space activation without losing the window.
        let _ = win.set_visible_on_all_workspaces(true);
    }

    let policy = if want_regular {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    if let Err(e) = app.set_activation_policy(policy) {
        tracing::warn!(%e, want_regular, "failed to switch activation policy");
        return;
    }

    let Some((win, pos, stick_pt)) = restore else {
        return;
    };
    if want_regular {
        enable_native_fullscreen(&win);
    }
    // Cursor on the user's display *before* activateIgnoringOtherApps (set_focus).
    warp_mouse(stick_pt.0, stick_pt.1);
    let _ = win.set_position(tauri::Position::Physical(pos));
    let _ = win.set_focus();
    if want_regular {
        schedule_display_settle(win, pos, stick_pt);
    }
}

#[cfg(not(target_os = "macos"))]
fn sync_dock_policy(
    _app: &AppHandle,
    _focus: Option<&tauri::WebviewWindow>,
    _except: Option<&str>,
) {
}

/// Show the recorder bar after a full-screen overlay (area pick) and pin to all Spaces.
pub(crate) fn reveal_recorder_bar(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(RECORDER_LABEL) {
        set_follows_spaces(&win, true);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Hide the recorder popover (close button / after stop).
#[tauri::command]
pub fn hide_recorder(app: AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(RECORDER_LABEL) {
        set_follows_spaces(&win, false);
        win.hide()?;
    }
    Ok(())
}

/// Resize the recorder window: `setup` | `alert` | `dropdown` | `menu` | `hud`
/// | `countdown`.
/// Centered layouts (`countdown`) park a compact card on the primary display
/// and restore the prior tray position when leaving.
/// `alert` is setup height plus room for the error toast under the bar.
#[tauri::command]
pub fn set_recorder_layout(app: AppHandle, layout: String) -> tauri::Result<()> {
    let Some(win) = app.get_webview_window(RECORDER_LABEL) else {
        return Ok(());
    };

    if let Some((w, h)) = centered_layout_dims(&layout) {
        apply_centered_recorder_layout(&app, &win, w, h)?;
    } else {
        let _ = win.set_min_size(None::<tauri::LogicalSize<f64>>);
        let _ = win.set_max_size(None::<tauri::LogicalSize<f64>>);
        win.set_size(tauri::Size::Logical(layout_size(&layout)))?;
        if let Ok(mut slot) = PRE_CENTERED_POS.lock() {
            if let Some((x, y)) = slot.take() {
                let _ = win.set_position(tauri::Position::Logical(
                    tauri::LogicalPosition::new(x, y),
                ));
            }
        }
    }

    // macOS can drop the Spaces pin after resize; re-apply while the bar is open.
    pin_to_all_spaces_if_shown(&win);
    Ok(())
}

/// Lock size, place on the primary work area, remember prior tray position once.
fn apply_centered_recorder_layout(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> tauri::Result<()> {
    if let Ok(pos) = win.outer_position() {
        let scale = win.scale_factor().unwrap_or(1.0);
        if let Ok(mut slot) = PRE_CENTERED_POS.lock() {
            // Keep the first pre-center position if countdown re-applies.
            if slot.is_none() {
                *slot = Some((pos.x as f64 / scale, pos.y as f64 / scale));
            }
        }
    }
    let size = tauri::LogicalSize::new(width, height);
    let _ = win.set_min_size(Some(size));
    let _ = win.set_max_size(Some(size));
    // Physical size avoids logical round-trip drift on retina displays.
    let scale = win.scale_factor().unwrap_or(1.0);
    win.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    )))?;
    let (x, y) = primary_work_area_origin_for_size(app, width, height);
    win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)))?;
    Ok(())
}

/// Toggle the frameless recorder popover attached to the tray. Creates it lazily.
pub fn toggle_recorder_popover(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(RECORDER_LABEL) {
        if win.is_visible().unwrap_or(false) {
            set_follows_spaces(&win, false);
            win.hide()?;
        } else {
            let _ = win.set_size(tauri::Size::Logical(layout_size("setup")));
            set_follows_spaces(&win, true);
            win.show()?;
            win.set_focus()?;
        }
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(app, RECORDER_LABEL, WebviewUrl::App("recorder.html".into()))
        .title("Capptivo")
        .inner_size(setup_bar_width(), LAYOUT_SETUP_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // First click must always act: once the annotation overlay (or any
        // other window) takes key status, macOS otherwise swallows the next
        // HUD click just to refocus — the "click twice to toggle" feel.
        .accept_first_mouse(true)
        .visible(true)
        .build()?;
    set_follows_spaces(&win, true);
    win.set_focus()?;
    Ok(())
}

/// Show (or update) the frameless always-on-top webcam preview. Placement only —
/// shape/radius for the *export* face-cam live in the editor.
#[tauri::command]
pub fn show_camera_preview(app: AppHandle, device_id: String) -> tauri::Result<()> {
    if device_id.is_empty() {
        return hide_camera_preview(app);
    }

    if let Some(win) = app.get_webview_window(CAMERA_LABEL) {
        let mut last = LAST_CAMERA_DEVICE.lock().unwrap_or_else(|e| e.into_inner());
        if last.as_deref() != Some(device_id.as_str()) {
            *last = Some(device_id.clone());
            let _ = win.emit(CAMERA_DEVICE_EVENT, &device_id);
        }
        let _ = win.set_content_protected(false);
        set_follows_spaces(&win, true);
        win.show()?;
        return Ok(());
    }

    {
        let mut last = LAST_CAMERA_DEVICE.lock().unwrap_or_else(|e| e.into_inner());
        *last = Some(device_id.clone());
    }

    let url = format!(
        "camera.html?device={}",
        urlencoding_minimal(&device_id)
    );
    let (x, y) = camera_default_position(&app);
    let win = WebviewWindowBuilder::new(&app, CAMERA_LABEL, WebviewUrl::App(url.into()))
        .title("Capptivo Camera")
        .inner_size(CAMERA_W, CAMERA_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // Exclude via ScreenCaptureKit `excluded_targets` — content_protected
        // blacks the bubble on some macOS versions once capture starts.
        .content_protected(false)
        .visible(true)
        .position(x, y)
        .build()?;
    let _ = win.set_content_protected(false);
    set_follows_spaces(&win, true);
    // Bubble opened mid-recording: apply the Windows capture opt-out now
    // (recordings started later re-apply it to all overlay chrome).
    if recording_active(&app) {
        set_capture_exclusion(&app, true);
    }
    Ok(())
}

/// Tear down the camera preview and release the WebView (stops getUserMedia).
/// Emits `camera://closed` so the recorder toggle clears (user dismissed).
#[tauri::command]
pub fn hide_camera_preview(app: AppHandle) -> tauri::Result<()> {
    close_camera_window(&app, true)
}

/// Close the setup bubble without clearing the recorder camera toggle —
/// used when handing the device to the recorder WebView for capture.
#[tauri::command]
pub fn dismiss_camera_preview(app: AppHandle) -> tauri::Result<()> {
    close_camera_window(&app, false)
}

fn close_camera_window(app: &AppHandle, notify: bool) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(CAMERA_LABEL) {
        set_follows_spaces(&win, false);
        let _ = win.close();
    }
    if let Ok(mut last) = LAST_CAMERA_DEVICE.lock() {
        *last = None;
    }
    if notify {
        let _ = app.emit(CAMERA_CLOSED_EVENT, ());
    }
    Ok(())
}

/// Show/hide without destroying the WebView (keeps the stream for separate-track capture).
#[tauri::command]
pub fn set_camera_preview_visible(app: AppHandle, visible: bool) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(CAMERA_LABEL) {
        if visible {
            set_follows_spaces(&win, true);
            win.show()?;
        } else {
            set_follows_spaces(&win, false);
            win.hide()?;
        }
    }
    Ok(())
}

/// Ask the camera WebView to flush its MediaRecorder before project finalize.
#[tauri::command]
pub fn flush_camera_capture(app: AppHandle) -> tauri::Result<()> {
    let _ = app.emit(CAMERA_CAPTURE_FLUSH, ());
    Ok(())
}

/// Notify the camera WebView to start capturing (preview stays visible; SCK excludes it).
pub fn emit_camera_capture_start(app: &AppHandle, project_id: &str) {
    let _ = app.emit(CAMERA_CAPTURE_START, project_id);
}

#[tauri::command]
pub fn flush_mic_capture(app: AppHandle) -> tauri::Result<()> {
    let _ = app.emit(MIC_CAPTURE_FLUSH, ());
    Ok(())
}

pub fn emit_mic_capture_start(app: &AppHandle, project_id: &str) {
    let _ = app.emit(MIC_CAPTURE_START, project_id);
}

fn position_annotation_on_active_display(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
) -> tauri::Result<()> {
    let monitor = match active_monitor(app).or_else(|| app.primary_monitor().ok().flatten()) {
        Some(m) => m,
        None => return Ok(()),
    };
    let pos = monitor.position();
    let size = monitor.size();
    win.set_size(tauri::Size::Physical(*size))?;
    win.set_position(tauri::Position::Physical(*pos))?;
    // Same as the recorder bar: macOS can drop CanJoinAllSpaces after resize.
    pin_to_all_spaces_if_shown(win);
    Ok(())
}

static ANNOTATION_ESCAPE_ARMED: AtomicBool = AtomicBool::new(false);
/// Native follow loop is running (overlay visible).
static ANNOTATION_FOLLOW_ON: AtomicBool = AtomicBool::new(false);
/// Bumped on stop so a sleeping worker exits even if FOLLOW_ON flips true again.
static ANNOTATION_FOLLOW_GEN: AtomicU32 = AtomicU32::new(0);
/// When false (a drawing tool is armed), skip monitor hops so the canvas
/// isn't yanked mid-stroke. Set from the WebView via IPC.
static ANNOTATION_FOLLOW_DISPLAY: AtomicBool = AtomicBool::new(true);

fn start_annotation_display_follow(app: &AppHandle) {
    ANNOTATION_FOLLOW_DISPLAY.store(true, Ordering::Relaxed);
    if ANNOTATION_FOLLOW_ON.swap(true, Ordering::SeqCst) {
        return;
    }
    let gen = ANNOTATION_FOLLOW_GEN.load(Ordering::SeqCst);
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("annotation-display".into())
        .spawn(move || {
            while ANNOTATION_FOLLOW_ON.load(Ordering::SeqCst)
                && ANNOTATION_FOLLOW_GEN.load(Ordering::SeqCst) == gen
            {
                if ANNOTATION_FOLLOW_DISPLAY.load(Ordering::Relaxed) {
                    let _ = sync_annotation_display_inner(&app);
                }
                std::thread::sleep(ANNOTATION_FOLLOW_INTERVAL);
            }
        });
}

fn stop_annotation_display_follow() {
    ANNOTATION_FOLLOW_ON.store(false, Ordering::SeqCst);
    ANNOTATION_FOLLOW_GEN.fetch_add(1, Ordering::SeqCst);
}

/// WebView reports click-through vs drawing so the native follow loop can
/// skip hops while a tool is armed (yank mid-stroke). No-op when hidden.
#[tauri::command]
pub fn set_annotation_display_follow(follow: bool) {
    ANNOTATION_FOLLOW_DISPLAY.store(follow, Ordering::Relaxed);
}

fn arm_annotation_escape(app: &AppHandle) {
    if ANNOTATION_ESCAPE_ARMED.swap(true, Ordering::SeqCst) {
        return;
    }
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let result = app.global_shortcut().on_shortcut(ANNOTATION_ESCAPE_HOTKEY, |app, _, event| {
        if event.state() != ShortcutState::Pressed {
            return;
        }
        let Some(win) = app.get_webview_window(ANNOTATION_LABEL) else {
            return;
        };
        if !win.is_visible().unwrap_or(false) {
            return;
        }
        let _ = app.emit(ANNOTATION_ESCAPE_EVENT, ());
    });
    if let Err(e) = result {
        ANNOTATION_ESCAPE_ARMED.store(false, Ordering::SeqCst);
        tracing::warn!(%e, "failed to register annotation Escape hotkey");
    }
}

fn disarm_annotation_escape(app: &AppHandle) {
    if !ANNOTATION_ESCAPE_ARMED.swap(false, Ordering::SeqCst) {
        return;
    }
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Err(e) = app.global_shortcut().unregister(ANNOTATION_ESCAPE_HOTKEY) {
        tracing::warn!(%e, "failed to unregister annotation Escape hotkey");
    }
}

/// Toggle the fullscreen annotation toolbar. Usable with or without recording
/// (tray menu "Annotate Screen…" vs the HUD highlighter during a take).
pub fn toggle_annotation_overlay(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(ANNOTATION_LABEL) {
        if win.is_visible().unwrap_or(false) {
            return hide_annotation_overlay(app.clone());
        }
    }
    show_annotation_overlay(app.clone())
}

/// Full-screen ink overlay while recording. Not SCK-excluded so drawings land
/// in `screen.mp4` (same idea as the extension page overlay).
#[tauri::command]
pub fn show_annotation_overlay(app: AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(ANNOTATION_LABEL) {
        position_annotation_on_active_display(&app, &win)?;
        set_follows_spaces(&win, true);
        win.show()?;
        let _ = app.emit(ANNOTATION_VISIBILITY_EVENT, true);
        arm_annotation_escape(&app);
        start_annotation_display_follow(&app);
        raise_recording_chrome(&app);
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(
        &app,
        ANNOTATION_LABEL,
        WebviewUrl::App("annotation.html".into()),
    )
    .title("Capptivo Annotation")
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    // Same first-click rule as the recorder bar: the overlay is click-through
    // most of the time, so it's almost never the key window when the user
    // clicks its toolbar — without this the first click only refocuses.
    .accept_first_mouse(true)
    .visible(false)
    .build()?;

    position_annotation_on_active_display(&app, &win)?;
    set_follows_spaces(&win, true);
    win.show()?;
    let _ = app.emit(ANNOTATION_VISIBILITY_EVENT, true);
    arm_annotation_escape(&app);
    start_annotation_display_follow(&app);
    // Ink is fullscreen always-on-top — re-assert HUD / face-cam above it or
    // the highlighter toggle (and camera) are unreachable.
    raise_recording_chrome(&app);
    Ok(())
}

/// Keep recorder HUD + face-cam above the annotation layer (same always-on-top
/// band; last `set_always_on_top(true)` wins the z-order on macOS).
fn raise_recording_chrome(app: &AppHandle) {
    if let Some(rec) = app.get_webview_window(RECORDER_LABEL) {
        let _ = rec.set_always_on_top(true);
    }
    if let Some(cam) = app.get_webview_window(CAMERA_LABEL) {
        let _ = cam.set_always_on_top(true);
    }
}

#[tauri::command]
pub fn hide_annotation_overlay(app: AppHandle) -> tauri::Result<()> {
    stop_annotation_display_follow();
    if let Some(win) = app.get_webview_window(ANNOTATION_LABEL) {
        set_follows_spaces(&win, false);
        win.hide()?;
        let _ = app.emit(ANNOTATION_VISIBILITY_EVENT, false);
        disarm_annotation_escape(&app);
    }
    Ok(())
}

/// Move the annotation overlay to the cursor's display when it changed.
/// Driven by a native thread while the overlay is visible — WebView timers
/// get App-Nap'd once the window is click-through / unfocused, which is why
/// a JS poll never kept up with the recorder bar's Spaces pin.
/// No-op when already on the right display. Skipped while a drawing tool is
/// armed (`set_annotation_display_follow(false)`).
fn sync_annotation_display_inner(app: &AppHandle) -> tauri::Result<()> {
    let Some(win) = app.get_webview_window(ANNOTATION_LABEL) else {
        return Ok(());
    };
    if !win.is_visible().unwrap_or(false) {
        return Ok(());
    }
    let Some(target) = active_monitor(app) else {
        return Ok(());
    };
    // Same display → nothing to do (the common case on every poll tick).
    if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
        let cx = pos.x as f64 + size.width as f64 / 2.0;
        let cy = pos.y as f64 + size.height as f64 / 2.0;
        if let Some(current) = monitor_at_physical(app, cx, cy) {
            if current.position() == target.position() {
                return Ok(());
            }
        }
    }
    position_annotation_on_active_display(app, &win)?;
    let _ = app.emit(ANNOTATION_DISPLAY_EVENT, ());
    // Keep HUD / face-cam above the freshly moved fullscreen layer.
    raise_recording_chrome(app);
    Ok(())
}

/// Percent-encode a device id for the query string (alnum / `-` / `_` pass through).
fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn primary_work_area_origin_for_size(app: &AppHandle, width: f64, height: f64) -> (f64, f64) {
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return (80.0, 80.0);
    };
    work_area_origin_for_size(&monitor, width, height)
}

fn work_area_origin_for_size(monitor: &tauri::Monitor, width: f64, height: f64) -> (f64, f64) {
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let ww = work.size.width as f64 / scale;
    let wh = work.size.height as f64 / scale;
    let wx = work.position.x as f64 / scale;
    let wy = work.position.y as f64 / scale;
    let x = wx + (ww - width).max(0.0) / 2.0;
    let y = wy + (wh - height).max(0.0) / 2.0;
    (x, y)
}

fn physical_work_area_origin(
    monitor: &tauri::Monitor,
    logical_w: f64,
    logical_h: f64,
) -> tauri::PhysicalPosition<i32> {
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let pw = (logical_w * scale).round() as i32;
    let ph = (logical_h * scale).round() as i32;
    let x = work.position.x + (work.size.width as i32 - pw).max(0) / 2;
    let y = work.position.y + (work.size.height as i32 - ph).max(0) / 2;
    tauri::PhysicalPosition::new(x, y)
}

fn monitor_at_physical(app: &AppHandle, px: f64, py: f64) -> Option<tauri::Monitor> {
    if let Ok(Some(m)) = app.monitor_from_point(px, py) {
        return Some(m);
    }
    // Fallback hit-test — `monitor_from_point` is flaky across mixed-DPI setups.
    let Ok(monitors) = app.available_monitors() else {
        return None;
    };
    for m in monitors {
        let pos = m.position();
        let size = m.size();
        let left = pos.x as f64;
        let top = pos.y as f64;
        let right = left + size.width as f64;
        let bottom = top + size.height as f64;
        if px >= left && px < right && py >= top && py < bottom {
            return Some(m);
        }
    }
    None
}

/// Display the user is looking at. Cursor wins — the recorder is pinned to all
/// Spaces (`visible_on_all_workspaces`), so its frame often still sits on the
/// primary display even when the user is interacting with it on screen 2.
fn active_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    if let Ok(pos) = app.cursor_position() {
        if let Some(m) = monitor_at_physical(app, pos.x, pos.y) {
            return Some(m);
        }
    }
    if let Some(rec) = app.get_webview_window(RECORDER_LABEL) {
        if let (Ok(pos), Ok(size)) = (rec.outer_position(), rec.outer_size()) {
            let cx = pos.x as f64 + size.width as f64 / 2.0;
            let cy = pos.y as f64 + size.height as f64 / 2.0;
            if let Some(m) = monitor_at_physical(app, cx, cy) {
                return Some(m);
            }
        }
    }
    app.primary_monitor().ok().flatten()
}

fn placement_origin_for_size(app: &AppHandle, width: f64, height: f64) -> (f64, f64) {
    match active_monitor(app) {
        Some(m) => work_area_origin_for_size(&m, width, height),
        None => (80.0, 80.0),
    }
}

fn move_window_to_active_monitor(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
    logical_w: f64,
    logical_h: f64,
) -> tauri::Result<()> {
    let Some(monitor) = active_monitor(app) else {
        return Ok(());
    };
    let pos = physical_work_area_origin(&monitor, logical_w, logical_h);
    win.set_position(tauri::Position::Physical(pos))?;
    Ok(())
}

/// Show on the cursor's display, then apply Dock/fullscreen policy.
/// Do not focus before the policy flip — overlays still joining all Spaces
/// (recorder frame on primary) make `activateIgnoringOtherApps` yank screen 1.
pub fn present_on_active_monitor(app: &AppHandle, win: &tauri::WebviewWindow) -> tauri::Result<()> {
    if win.is_minimized().unwrap_or(false) {
        win.unminimize()?;
    }

    prepare_shell_activation(app);

    let scale = win.scale_factor().unwrap_or(1.0);
    let size = win
        .inner_size()
        .unwrap_or(tauri::PhysicalSize::new(1280, 800));
    let w = size.width as f64 / scale;
    let h = size.height as f64 / scale;
    move_window_to_active_monitor(app, win, w, h)?;
    win.show()?;
    // Policy owns focus after Regular flip (see sync_dock_policy).
    sync_dock_policy(app, Some(win), None);
    Ok(())
}

fn show_focused_on_active_monitor(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
    logical_w: f64,
    logical_h: f64,
) -> tauri::Result<()> {
    if win.is_minimized().unwrap_or(false) {
        win.unminimize()?;
    }
    prepare_shell_activation(app);
    move_window_to_active_monitor(app, win, logical_w, logical_h)?;
    win.show()?;
    sync_dock_policy(app, Some(win), None);
    Ok(())
}

const EDITOR_W: f64 = 1280.0;
const EDITOR_H: f64 = 800.0;

/// Must match editor `EditorTitleBar` height (`h-11` = 44 logical px).
#[cfg(target_os = "macos")]
const EDITOR_TITLE_BAR_HEIGHT: f64 = 44.0;

/// Centers traffic lights in the title bar. wry sets container height to
/// `close_button_height + y` (see `inset_traffic_lights`); small `y` glues
/// buttons to the window top.
#[cfg(target_os = "macos")]
fn macos_traffic_light_y() -> f64 {
    const CLOSE_BTN_HEIGHT: f64 = 12.0;
    const NATURAL_ORIGIN_Y: f64 = 5.0;
    ((EDITOR_TITLE_BAR_HEIGHT - CLOSE_BTN_HEIGHT) / 2.0 + NATURAL_ORIGIN_Y).max(0.0)
}

fn editor_window_builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: &str,
    title: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let (x, y) = placement_origin_for_size(app, EDITOR_W, EDITOR_H);
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(EDITOR_W, EDITOR_H)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .position(x, y);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(12.0, macos_traffic_light_y()));
    }

    // Windows/Linux: the editor renders its own title bar (EditorTitleBar with
    // min/max/close controls), so native decorations would double up.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    builder
}

fn build_editor_window(
    app: &AppHandle,
    label: &str,
    url: &str,
    title: &str,
) -> tauri::Result<tauri::WebviewWindow> {
    let win = editor_window_builder(app, label, url, title).build()?;
    // Fullscreen bits + Dock policy applied inside present → sync_dock_policy
    // (must hop to the AppKit main thread — not safe on the tokio worker).
    present_on_active_monitor(app, &win)?;
    Ok(win)
}

fn emit_show_library(win: &tauri::WebviewWindow) {
    let _ = win.emit(SHOW_LIBRARY_EVENT, ());
}

/// Focus the invoking editor/library window on the user's current display (from JS).
#[tauri::command]
pub fn present_window(app: AppHandle, window: tauri::WebviewWindow) -> tauri::Result<()> {
    present_on_active_monitor(&app, &window)
}

/// Show the recordings grid inside an existing editor window, or open the
/// standalone library shell (`?view=library`) when none is open.
///
/// Opening the library flips macOS to `Regular` (same as a project editor) so
/// the green traffic light shows expand arrows. Overlays are dismissed/unpinned
/// first so that flip does not yank Mission Control to the primary display.
#[tauri::command]
pub fn open_library(app: AppHandle) -> tauri::Result<()> {
    // Prefer an already-open editor — same window, just swap the shell.
    let mut editors: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(EDITOR_LABEL_PREFIX))
        .collect();
    editors.sort_by(|a, b| a.0.cmp(&b.0));
    if let Some((_, win)) = editors.pop() {
        emit_show_library(&win);
        show_focused_on_active_monitor(&app, &win, EDITOR_W, EDITOR_H)?;
        return Ok(());
    }

    if let Some(win) = app.get_webview_window(LIBRARY_LABEL) {
        emit_show_library(&win);
        show_focused_on_active_monitor(&app, &win, EDITOR_W, EDITOR_H)?;
        return Ok(());
    }

    let _win = build_editor_window(
        &app,
        LIBRARY_LABEL,
        "editor.html?view=library",
        "Capptivo",
    )?;
    Ok(())
}

/// Open (or focus) the editor for a project. Used after stop and from the library.
#[tauri::command]
pub fn open_editor(app: AppHandle, project_id: String) -> tauri::Result<()> {
    open_editor_window(&app, &project_id)
}

/// Open (or focus) the editor window for a project. Switches the app to a
/// Dock-visible `Regular` activation policy on macOS.
pub fn open_editor_window(app: &AppHandle, project_id: &str) -> tauri::Result<()> {
    let label = format!("{EDITOR_LABEL_PREFIX}{project_id}");

    if let Some(win) = app.get_webview_window(&label) {
        present_on_active_monitor(app, &win)?;
        return Ok(());
    }

    let url = format!("editor.html?project={project_id}");
    let _win = build_editor_window(app, &label, &url, "Capptivo Editor")?;
    Ok(())
}

/// Close the editor for a project if it is open (e.g. after delete).
pub fn close_editor_if_open(app: &AppHandle, project_id: &str) {
    let label = format!("{EDITOR_LABEL_PREFIX}{project_id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
}

/// When the last library/editor window closes, drop back to menubar-only.
/// `closing` is the label of the window being destroyed — it may still be
/// listed by Tauri while the event fires.
pub fn refresh_activation_policy(app: &AppHandle, closing: &str) {
    sync_dock_policy(app, None, Some(closing));
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::fullscreen_bits;

    #[test]
    fn native_fullscreen_bits_force_primary_arrows() {
        // Default / empty → primary + allows tiling.
        assert_eq!(
            fullscreen_bits::with_native_fullscreen(0),
            fullscreen_bits::PRIMARY | fullscreen_bits::ALLOWS_TILING
        );
        // Auxiliary (zoom "+") must be cleared.
        let aux = fullscreen_bits::AUXILIARY | fullscreen_bits::DISALLOWS_TILING;
        let got = fullscreen_bits::with_native_fullscreen(aux);
        assert_eq!(got & fullscreen_bits::AUXILIARY, 0);
        assert_eq!(got & fullscreen_bits::DISALLOWS_TILING, 0);
        assert_ne!(got & fullscreen_bits::PRIMARY, 0);
        assert_ne!(got & fullscreen_bits::ALLOWS_TILING, 0);
        // Preserve unrelated bits (e.g. managed).
        const MANAGED: usize = 1 << 2;
        assert_eq!(
            fullscreen_bits::with_native_fullscreen(MANAGED) & MANAGED,
            MANAGED
        );
    }
}

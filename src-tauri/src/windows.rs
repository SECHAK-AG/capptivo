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

/// Gap between the recorder bar and the bottom of the work area (above the Dock).
const RECORDER_BOTTOM_MARGIN: f64 = 20.0;

/// Bottom-center of the primary work area — setup / HUD dock.
fn recorder_bottom_center(app: &AppHandle, width: f64, height: f64) -> (f64, f64) {
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return (80.0, 80.0);
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let ww = work.size.width as f64 / scale;
    let wh = work.size.height as f64 / scale;
    let wx = work.position.x as f64 / scale;
    let wy = work.position.y as f64 / scale;
    let x = wx + (ww - width).max(0.0) / 2.0;
    let y = wy + (wh - height).max(0.0) - RECORDER_BOTTOM_MARGIN;
    (x, y.max(wy))
}

/// Setup toolbar (Display / devices / Record).
/// Width comes from the webview (`set_recorder_bar_width`) so the pill never clips
/// — only used as a fallback before the first measure; setup itself is a
/// work-area overlay (see [`apply_setup_overlay`]).
const LAYOUT_SETUP_H: f64 = 64.0;
const LAYOUT_SETUP_W_FALLBACK: f64 = 880.0;
const LAYOUT_SETUP_W_MIN: f64 = 640.0;
const LAYOUT_SETUP_W_MAX: f64 = 1200.0;
/// Setup toolbar + error toast underneath (toast used to clip to a red sliver).
const LAYOUT_ALERT_H: f64 = 120.0;
/// Compact live HUD (status + icon controls).
const LAYOUT_HUD: (f64, f64) = (420.0, 56.0);
/// Collapsed HUD chip (REC + timer + expand).
const LAYOUT_HUD_MINI: (f64, f64) = (168.0, 48.0);
/// Countdown badge (centered on the primary display).
/// Must stay square — a wide leftover setup width makes the digit look
/// top/bottom-cramped with huge side gaps.
const LAYOUT_COUNTDOWN: (f64, f64) = (240.0, 240.0);

/// What the recorder window is showing. Popovers are never a layout of their
/// own — they are extra space reserved *next to* one of these, so opening a
/// menu cannot resize or re-dock the bar itself (see [`set_recorder_menu`]).
#[derive(Clone, Copy, PartialEq, Eq)]
enum RecorderLayout {
    Setup,
    Alert,
    Hud,
    HudMini,
    Countdown,
}

impl RecorderLayout {
    fn parse(name: &str) -> Self {
        match name {
            "alert" => Self::Alert,
            "hud" => Self::Hud,
            "hud-mini" => Self::HudMini,
            "countdown" => Self::Countdown,
            _ => Self::Setup,
        }
    }

    fn chrome_height(self) -> f64 {
        match self {
            Self::Setup => LAYOUT_SETUP_H,
            Self::Alert => LAYOUT_ALERT_H,
            Self::Hud => LAYOUT_HUD.1,
            Self::HudMini => LAYOUT_HUD_MINI.1,
            Self::Countdown => LAYOUT_COUNTDOWN.1,
        }
    }

    fn size(self) -> tauri::LogicalSize<f64> {
        let (w, h) = match self {
            // Setup/alert are work-area overlays — callers that need a real
            // frame use [`apply_setup_overlay`]. This fallback is only for
            // first-paint before the monitor is known.
            Self::Setup => (LAYOUT_SETUP_W_FALLBACK, LAYOUT_SETUP_H),
            Self::Alert => (LAYOUT_SETUP_W_FALLBACK, LAYOUT_ALERT_H),
            Self::Hud => LAYOUT_HUD,
            Self::HudMini => LAYOUT_HUD_MINI,
            Self::Countdown => LAYOUT_COUNTDOWN,
        };
        tauri::LogicalSize::new(w, h)
    }

    /// The setup pill is the only layout that hosts popovers, and the only
    /// one that covers the work area so the bar can CSS-drag without resizing.
    fn is_setup_bar(self) -> bool {
        matches!(self, Self::Setup | Self::Alert)
    }
}

/// Side of the bar an open popover grows toward. Kept for IPC compatibility;
/// setup is a work-area overlay and Radix flips popovers inside it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MenuSide {
    Top,
    Bottom,
}

impl MenuSide {
    fn parse(name: &str) -> Self {
        if name == "bottom" {
            Self::Bottom
        } else {
            Self::Top
        }
    }
}

/// Recorder window geometry. Setup covers the work area; the webview CSS-positions
/// the pill and reports its hitbox for click-through. HUD/countdown stay compact.
struct RecorderGeometry {
    layout: RecorderLayout,
    menu_side: MenuSide,
    /// Legacy field — setup overlay keeps this at 0 (no reserved strip).
    menu_height: f64,
}

static GEOMETRY: Mutex<RecorderGeometry> = Mutex::new(RecorderGeometry {
    layout: RecorderLayout::Setup,
    menu_side: MenuSide::Top,
    menu_height: 0.0,
});

fn geometry() -> std::sync::MutexGuard<'static, RecorderGeometry> {
    GEOMETRY.lock().unwrap_or_else(|e| e.into_inner())
}

/// Popover is open in the setup frame — disable click-through for the menu room.
static MENU_LIVE: AtomicBool = AtomicBool::new(false);
/// Setup pill is being dragged (CSS drag — window size stays put).
static RECORDER_DRAGGING: AtomicBool = AtomicBool::new(false);
/// Setup click-through poller is running.
static CLICK_THROUGH_ON: AtomicBool = AtomicBool::new(false);

/// Webview-local hitbox of the setup/HUD chrome (x, y, w, h). Used so the
/// work-area overlay can click-through everywhere except the pill + menus.
static BAR_HITBOX: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

/// Last measured setup-bar width (logical px). Cached for diagnostics; setup
/// is a work-area overlay so width no longer drives the native frame.
static SETUP_BAR_W: AtomicU32 = AtomicU32::new(0);

/// Window rect in logical points, top-left origin — the space Tauri and the
/// webview both speak.
#[derive(Clone, Copy)]
struct WinRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl WinRect {
    fn bottom(self) -> f64 {
        self.y + self.h
    }
}

fn window_rect(win: &tauri::WebviewWindow) -> tauri::Result<WinRect> {
    let scale = win.scale_factor()?;
    let pos = win.outer_position()?;
    let size = win.outer_size()?;
    Ok(WinRect {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        w: size.width as f64 / scale,
        h: size.height as f64 / scale,
    })
}

/// The bar's own top / bottom edges in screen space — from the webview hitbox
/// when present, else a bottom-strip fallback before the first report.
fn bar_edges(win: &tauri::WebviewWindow) -> tauri::Result<(f64, f64)> {
    let rect = window_rect(win)?;
    if let Some((x, y, _w, h)) = *BAR_HITBOX.lock().unwrap_or_else(|e| e.into_inner()) {
        let _ = x;
        return Ok((rect.y + y, rect.y + y + h));
    }
    let chrome = geometry().layout.chrome_height();
    Ok((rect.bottom() - chrome - RECORDER_BOTTOM_MARGIN, rect.bottom() - RECORDER_BOTTOM_MARGIN))
}

/// Move + resize the recorder as a **single** window-server update.
///
/// `set_size` and `set_position` are two updates, and WebKit re-lays the
/// WebView out on each one — so every grow-and-move (which is every popover)
/// presented an in-between frame with the bar drawn against the wrong edge.
/// That frame is the bar visibly jumping when a menu opens or closes. One
/// platform call means there is no in-between to draw.
///
/// Returns only after the frame has been applied. Queue-and-forget was the
/// menu flicker: geometry updated while the on-screen frame lagged, so the
/// next open/close computed `bar_top` from a desynced rect and yanked the
/// bar toward the screen center.
fn set_recorder_frame(win: &tauri::WebviewWindow, rect: WinRect) -> tauri::Result<()> {
    set_window_frame(win, rect)
}

/// Run `work` on the AppKit/UI thread and wait for it. If we are already on
/// that thread, run inline — `recv` after a queued main-thread block would
/// deadlock.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_window_sync(
    win: &tauri::WebviewWindow,
    work: impl FnOnce() + Send + 'static,
) -> tauri::Result<()> {
    if is_ui_thread() {
        work();
        return Ok(());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    win.run_on_main_thread(move || {
        work();
        let _ = tx.send(());
    })?;
    let _ = rx.recv();
    Ok(())
}

#[cfg(target_os = "macos")]
fn is_ui_thread() -> bool {
    use objc::{class, msg_send, sel, sel_impl};
    unsafe { msg_send![class!(NSThread), isMainThread] }
}

#[cfg(target_os = "windows")]
fn is_ui_thread() -> bool {
    // Recorder IPC runs on the async pool, not the UI thread. Nested calls
    // from a UI-thread closure use the inline path via the same check on
    // macOS; on Windows we never nest `set_window_frame` inside itself.
    false
}

/// macOS: `-[NSWindow setFrame:display:]` takes origin and size together.
/// Must run on the AppKit main thread — every other window mutation in this
/// file follows the same rule.
#[cfg(target_os = "macos")]
fn set_window_frame(win: &tauri::WebviewWindow, rect: WinRect) -> tauri::Result<()> {
    let win = win.clone();
    run_window_sync(&win.clone(), move || {
        use core_graphics::geometry::{CGPoint, CGRect, CGSize};
        use objc::runtime::{Object, YES};
        use objc::{class, msg_send, sel, sel_impl};

        let Ok(ptr) = win.ns_window() else {
            return;
        };
        let ns_window = ptr as *mut Object;
        unsafe {
            // AppKit's screen space is bottom-left origin, anchored to the
            // primary display; Tauri hands us top-left points.
            let screens: *mut Object = msg_send![class!(NSScreen), screens];
            let count: usize = msg_send![screens, count];
            if count == 0 {
                return;
            }
            let primary: *mut Object = msg_send![screens, objectAtIndex: 0usize];
            let primary_frame: CGRect = msg_send![primary, frame];
            let flip = primary_frame.origin.y + primary_frame.size.height;
            let frame = CGRect::new(
                &CGPoint::new(rect.x, flip - rect.bottom()),
                &CGSize::new(rect.w, rect.h),
            );
            let _: () = msg_send![ns_window, setFrame: frame display: YES];
        }
    })
}

/// Windows: `SetWindowPos` moves and sizes in one message.
#[cfg(target_os = "windows")]
fn set_window_frame(win: &tauri::WebviewWindow, rect: WinRect) -> tauri::Result<()> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

    let scale = win.scale_factor()?;
    // `HWND` is a raw handle; carry it across the thread hop as an integer.
    let handle = win.hwnd()?.0 as isize;
    run_window_sync(&win.clone(), move || {
        let hwnd = HWND(handle as *mut std::ffi::c_void);
        if let Err(e) = unsafe {
            SetWindowPos(
                hwnd,
                None,
                (rect.x * scale).round() as i32,
                (rect.y * scale).round() as i32,
                (rect.w * scale).round() as i32,
                (rect.h * scale).round() as i32,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        } {
            tracing::warn!(%e, "recorder: SetWindowPos failed");
        }
    })
}

/// Other platforms: two calls, size first so the move lands last.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn set_window_frame(win: &tauri::WebviewWindow, rect: WinRect) -> tauri::Result<()> {
    win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        rect.w, rect.h,
    )))?;
    win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
        rect.x, rect.y,
    )))?;
    Ok(())
}

/// Webview reports the setup pill's content width. Setup is a work-area overlay
/// now, so this only caches the width — it must not resize the native window
/// (that resize was a drag/open flicker source).
#[tauri::command]
pub fn set_recorder_bar_width(_app: AppHandle, width: f64) -> tauri::Result<()> {
    let w = width.ceil().clamp(LAYOUT_SETUP_W_MIN, LAYOUT_SETUP_W_MAX) as u32;
    SETUP_BAR_W.store(w, Ordering::Relaxed);
    Ok(())
}

/// Webview-local hitbox of interactive chrome (pill + open menu). Drives
/// click-through on the work-area overlay.
#[tauri::command]
pub fn set_recorder_bar_hitbox(x: f64, y: f64, width: f64, height: f64) {
    *BAR_HITBOX.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((x, y, width.max(1.0), height.max(1.0)));
}

/// macOS Spaces / Linux workspaces: keep overlay chrome (recorder / face-cam)
/// on every desktop while visible — zero-cost OS pin, no cursor polling.
/// Windows has no equivalent API; `always_on_top` alone is the behavior there.
///
/// macOS: tao writes `collectionBehavior` on the calling thread, and mutating a
/// visible window off the AppKit main thread makes it flicker (same rule as
/// [`enable_native_fullscreen`]). Only ever call this on a real transition —
/// re-applying it per resize is what made the bar blink under every popover.
#[cfg(target_os = "macos")]
fn set_follows_spaces(win: &tauri::WebviewWindow, follows: bool) {
    let win = win.clone();
    let queued = win.clone().run_on_main_thread(move || {
        if let Err(e) = win.set_visible_on_all_workspaces(follows) {
            tracing::warn!(
                %e,
                follows,
                label = win.label(),
                "overlay: failed to set visible on all workspaces"
            );
        }
    });
    if let Err(e) = queued {
        tracing::warn!(%e, follows, "overlay: could not reach the AppKit main thread");
    }
}

#[cfg(target_os = "linux")]
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
/// Annotation is deliberately omitted — ink is meant to land in the recording.
/// Editor / library are never listed (title-based matching used to collide with
/// the HUD's `"Capptivo"` title and black out fullscreen shells).
#[cfg(any(target_os = "macos", target_os = "windows"))]
const CAPTURE_EXCLUDED_LABELS: &[&str] = &[RECORDER_LABEL, CAMERA_LABEL];

/// macOS: CGWindowIDs (`NSWindow.windowNumber`) for SCK `excluded_targets`.
/// Prefer this over window *titles* — titles change (library `setTitle`, rename).
#[cfg(target_os = "macos")]
pub fn overlay_cgwindow_ids(app: &AppHandle) -> Vec<u32> {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};

    let mut ids = Vec::with_capacity(CAPTURE_EXCLUDED_LABELS.len());
    for label in CAPTURE_EXCLUDED_LABELS {
        let Some(win) = app.get_webview_window(label) else {
            continue;
        };
        let Ok(ptr) = win.ns_window() else {
            continue;
        };
        let ns_window = ptr as *mut Object;
        // windowNumber == CGWindowID == scap Target::Window.id
        let number: isize = unsafe { msg_send![ns_window, windowNumber] };
        if number > 0 {
            ids.push(number as u32);
        }
    }
    ids
}

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

    /// Bit that lets a window appear over *another app's* native-fullscreen
    /// Space. `CanJoinAllSpaces` alone only covers standard Spaces, which is
    /// why the ink overlay used to stay on the primary display whenever the
    /// target display was showing a fullscreen app.
    pub const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    /// AppKit documents `CanJoinAllSpaces` and `MoveToActiveSpace` as mutually
    /// exclusive, so the overlay policy has to clear this rather than OR around
    /// it — `set_visible_on_all_workspaces(false)` on hide can leave it set.
    pub const MOVE_TO_ACTIVE_SPACE: usize = 1 << 1;

    /// Force expand-arrow fullscreen: clear auxiliary / disallow-tiling, set
    /// primary + allows-tiling. Sequoia otherwise uses a flaky heuristic that
    /// intermittently reverts the green button to "+".
    pub fn with_native_fullscreen(existing: usize) -> usize {
        let cleared = existing & !(AUXILIARY | DISALLOWS_TILING);
        cleared | PRIMARY | ALLOWS_TILING
    }

    /// Overlay policy: reachable on every Space, including fullscreen ones.
    /// `PRIMARY` must be cleared — a window that is itself fullscreen-primary
    /// gets its own Space instead of floating over someone else's.
    pub fn with_overlay_spaces(existing: usize) -> usize {
        let cleared = existing & !(PRIMARY | DISALLOWS_TILING | MOVE_TO_ACTIVE_SPACE);
        cleared | AUXILIARY | CAN_JOIN_ALL_SPACES
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

/// Give the annotation overlay `FullScreenAuxiliary | CanJoinAllSpaces` so it
/// can be moved onto a display whose Space belongs to a fullscreen app.
/// Main-thread only — see `enable_native_fullscreen`.
///
/// Deliberately *not* `with_native_fullscreen`: that policy serves the editor /
/// library shells' green expand arrows and clears the very bit the overlay needs.
#[cfg(target_os = "macos")]
fn apply_overlay_spaces(win: &tauri::WebviewWindow) {
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
        let next = fullscreen_bits::with_overlay_spaces(existing);
        if next != existing {
            let _: () = msg_send![ns_window, setCollectionBehavior: next];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn enable_native_fullscreen(_win: &tauri::WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
fn apply_overlay_spaces(_win: &tauri::WebviewWindow) {}

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
    let _ = show_recorder_popover(app);
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

/// Resize the recorder window: `setup` | `alert` | `hud` | `hud-mini` |
/// `countdown`. Setup/alert cover the monitor work area so the pill can
/// CSS-drag and popovers can flip inside the window — never a per-drag resize.
#[tauri::command]
pub fn set_recorder_layout(app: AppHandle, layout: String) -> tauri::Result<()> {
    let Some(win) = app.get_webview_window(RECORDER_LABEL) else {
        return Ok(());
    };
    let layout = RecorderLayout::parse(&layout);
    {
        let mut g = geometry();
        g.layout = layout;
        g.menu_height = 0.0;
        if !layout.is_setup_bar() {
            g.menu_side = MenuSide::Top;
            *BAR_HITBOX.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    if layout == RecorderLayout::Countdown {
        apply_centered_recorder_layout(&app, &win, LAYOUT_COUNTDOWN.0, LAYOUT_COUNTDOWN.1)?;
    } else if layout.is_setup_bar() {
        let _ = win.set_min_size(None::<tauri::LogicalSize<f64>>);
        let _ = win.set_max_size(None::<tauri::LogicalSize<f64>>);
        apply_setup_overlay(&app, &win)?;
    } else {
        let _ = win.set_min_size(None::<tauri::LogicalSize<f64>>);
        let _ = win.set_max_size(None::<tauri::LogicalSize<f64>>);
        let size = layout.size();
        apply_docked_recorder_size(&app, &win, size.width, size.height)?;
    }

    // macOS can drop the Spaces pin after resize; re-apply while the bar is open.
    pin_to_all_spaces_if_shown(&win);
    if layout.is_setup_bar() {
        ensure_setup_click_through(app.clone());
    } else {
        MENU_LIVE.store(false, Ordering::Relaxed);
        let _ = win.set_ignore_cursor_events(false);
    }
    Ok(())
}

/// Room (logical px) above and below the bar inside its monitor's work area.
/// The webview picks the popover side from this — same rule as a web dropdown,
/// except the "viewport" here is the screen, not the WebView.
#[derive(serde::Serialize)]
pub struct RecorderMenuSpace {
    pub above: f64,
    pub below: f64,
}

#[tauri::command]
pub fn recorder_menu_space(app: AppHandle) -> RecorderMenuSpace {
    let none = RecorderMenuSpace {
        above: 0.0,
        below: 0.0,
    };
    let Some(win) = app.get_webview_window(RECORDER_LABEL) else {
        return none;
    };
    let Ok((bar_top, bar_bottom)) = bar_edges(&win) else {
        return none;
    };
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return none;
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let work_top = work.position.y as f64 / scale;
    let work_bottom = work_top + work.size.height as f64 / scale;
    RecorderMenuSpace {
        above: (bar_top - work_top).max(0.0),
        below: (work_bottom - bar_bottom).max(0.0),
    }
}

/// Legacy IPC — setup is a work-area overlay; Radix flips popovers in-window.
/// Kept so older webviews do not crash on invoke.
#[tauri::command]
pub fn set_recorder_menu(_app: AppHandle, side: String, _height: f64) -> tauri::Result<()> {
    geometry().menu_side = MenuSide::parse(&side);
    Ok(())
}

/// Webview says a popover is open — the whole interactive hitbox must accept
/// clicks, so click-through turns off while the menu is live.
#[tauri::command]
pub fn set_recorder_menu_live(live: bool) {
    MENU_LIVE.store(live, Ordering::Relaxed);
}

/// Mark the setup pill as dragging. Does **not** resize the window — the
/// webview CSS-moves the pill inside the work-area overlay (resize-on-drag was
/// the click/unclick flicker).
#[tauri::command]
pub fn begin_recorder_drag(app: AppHandle) -> tauri::Result<String> {
    let Some(win) = app.get_webview_window(RECORDER_LABEL) else {
        return Ok("top".into());
    };
    RECORDER_DRAGGING.store(true, Ordering::Relaxed);
    let _ = win.set_ignore_cursor_events(false);
    Ok(side_str(geometry().menu_side))
}

/// Clear the dragging flag after a CSS drag. Window size is untouched.
#[tauri::command]
pub fn end_recorder_drag(_app: AppHandle) -> tauri::Result<String> {
    RECORDER_DRAGGING.store(false, Ordering::Relaxed);
    Ok(side_str(geometry().menu_side))
}

fn side_str(side: MenuSide) -> String {
    match side {
        MenuSide::Top => "top".into(),
        MenuSide::Bottom => "bottom".into(),
    }
}

/// The setup frame is permanently taller than the pill. Clicks on the empty
/// popover room must reach the desktop — poll the cursor and ignore events
/// unless it sits on the pill (or a live popover).
///
/// Becoming interactive is immediate; returning to click-through is debounced
/// so a cursor jittering on the pill edge cannot toggle `ignore_cursor_events`
/// every poll (that toggle redraws the transparent window and looks like flicker).
fn ensure_setup_click_through(app: AppHandle) {
    if CLICK_THROUGH_ON.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("recorder-click-through".into())
        .spawn(move || {
            let mut ignoring = false;
            let mut leave_ticks: u8 = 0;
            // ~100ms at 32ms poll — enough hysteresis without feeling sticky.
            const LEAVE_DEBOUNCE_TICKS: u8 = 3;
            loop {
                let Some(win) = app.get_webview_window(RECORDER_LABEL) else {
                    break;
                };
                let setup = geometry().layout.is_setup_bar();
                if !setup || !win.is_visible().unwrap_or(false) {
                    if ignoring {
                        let _ = win.set_ignore_cursor_events(false);
                        ignoring = false;
                    }
                    leave_ticks = 0;
                    if !setup {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }

                let interactive = RECORDER_DRAGGING.load(Ordering::Relaxed)
                    || MENU_LIVE.load(Ordering::Relaxed)
                    || cursor_over_recorder_bar(&app, &win);
                if interactive {
                    leave_ticks = 0;
                    if ignoring {
                        let _ = win.set_ignore_cursor_events(false);
                        ignoring = false;
                    }
                } else if !ignoring {
                    leave_ticks = leave_ticks.saturating_add(1);
                    if leave_ticks >= LEAVE_DEBOUNCE_TICKS {
                        let _ = win.set_ignore_cursor_events(true);
                        ignoring = true;
                        leave_ticks = 0;
                    }
                }
                std::thread::sleep(Duration::from_millis(32));
            }
            CLICK_THROUGH_ON.store(false, Ordering::SeqCst);
        });
}

fn cursor_over_recorder_bar(app: &AppHandle, win: &tauri::WebviewWindow) -> bool {
    let Ok(cursor) = app.cursor_position() else {
        return true;
    };
    let Ok(scale) = win.scale_factor() else {
        return true;
    };
    let Ok(rect) = window_rect(win) else {
        return true;
    };
    let cx = cursor.x / scale - rect.x;
    let cy = cursor.y / scale - rect.y;
    const PAD: f64 = 4.0;

    if let Some((x, y, w, h)) = *BAR_HITBOX.lock().unwrap_or_else(|e| e.into_inner()) {
        return cx >= x - PAD
            && cx <= x + w + PAD
            && cy >= y - PAD
            && cy <= y + h + PAD;
    }

    // Before the first hitbox report: bottom strip so the pill is reachable.
    let chrome = geometry().layout.chrome_height();
    cy >= rect.h - chrome - RECORDER_BOTTOM_MARGIN - PAD
}

/// Cover the current (or primary) monitor work area so the pill can CSS-drag
/// and popovers flip inside the window — window size stays fixed for the
/// whole setup session.
fn apply_setup_overlay(app: &AppHandle, win: &tauri::WebviewWindow) -> tauri::Result<()> {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    set_recorder_frame(
        win,
        WinRect {
            x: work.position.x as f64 / scale,
            y: work.position.y as f64 / scale,
            w: work.size.width as f64 / scale,
            h: work.size.height as f64 / scale,
        },
    )
}

/// Size and place at bottom-center in one frame change, so setup ↔ HUD swaps
/// stay visually anchored.
fn apply_docked_recorder_size(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> tauri::Result<()> {
    let (x, y) = recorder_bottom_center(app, width, height);
    set_recorder_frame(
        win,
        WinRect {
            x,
            y,
            w: width,
            h: height,
        },
    )
}

/// Lock size, place on the primary work area center (countdown badge).
fn apply_centered_recorder_layout(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> tauri::Result<()> {
    let size = tauri::LogicalSize::new(width, height);
    let _ = win.set_min_size(Some(size));
    let _ = win.set_max_size(Some(size));
    let (x, y) = primary_work_area_origin_for_size(app, width, height);
    set_recorder_frame(
        win,
        WinRect {
            x,
            y,
            w: width,
            h: height,
        },
    )
}

/// Create-or-show the recorder bar. Never hides — use for launch, Dock reopen,
/// and "Open Recorder". Tray click / hotkey keep [`toggle_recorder_popover`].
pub fn show_recorder_popover(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(RECORDER_LABEL) {
        if !win.is_visible().unwrap_or(false) {
            let layout = {
                let mut g = geometry();
                g.menu_height = 0.0;
                g.layout
            };
            if layout == RecorderLayout::Countdown {
                let size = layout.size();
                apply_centered_recorder_layout(app, &win, size.width, size.height)?;
            } else if layout.is_setup_bar() {
                apply_setup_overlay(app, &win)?;
            } else {
                let size = layout.size();
                apply_docked_recorder_size(app, &win, size.width, size.height)?;
            }
        }
        set_follows_spaces(&win, true);
        win.show()?;
        win.set_focus()?;
        if geometry().layout.is_setup_bar() {
            ensure_setup_click_through(app.clone());
        }
        return Ok(());
    }
    create_recorder_popover(app)
}

/// Toggle the frameless recorder popover attached to the tray. Creates it lazily.
pub fn toggle_recorder_popover(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(RECORDER_LABEL) {
        if win.is_visible().unwrap_or(false) {
            set_follows_spaces(&win, false);
            win.hide()?;
            return Ok(());
        }
    }
    show_recorder_popover(app)
}

fn create_recorder_popover(app: &AppHandle) -> tauri::Result<()> {
    // Build with a placeholder size, then immediately cover the work area —
    // builder needs *some* size before the window exists.
    let size = RecorderLayout::Setup.size();
    let (x, y) = recorder_bottom_center(app, size.width, size.height);
    let win = WebviewWindowBuilder::new(app, RECORDER_LABEL, WebviewUrl::App("recorder.html".into()))
        .title("Capptivo")
        .inner_size(size.width, size.height)
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
        .position(x, y)
        .build()?;
    apply_setup_overlay(app, &win)?;
    set_follows_spaces(&win, true);
    win.set_focus()?;
    ensure_setup_click_through(app.clone());
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

/// Move + resize the ink overlay to cover one whole display.
///
/// **Ordering is load-bearing.** `tao` converts a `Size::Physical` using the
/// window's *current* scale factor, so setting the size while the window still
/// sits on the old display applies the wrong logical size on a mixed-DPI pair.
/// Position first, then size, then re-assert the Spaces policy — macOS can drop
/// collection behavior across a resize.
///
/// **Thread is load-bearing.** Every call in here is AppKit window mutation and
/// must run on the main thread; `-[NSWindow setCollectionBehavior:]` aborts with
/// "Must only be used from the main thread" otherwise. The 300 ms follow loop
/// runs on its own `std::thread`, so it reaches this through `run_on_main_thread`.
fn position_annotation_on_active_display(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
) -> tauri::Result<()> {
    // `active_monitor` already ends in `primary_monitor()`, so there is no outer
    // fallback to add here.
    let Some(monitor) = active_monitor(app) else {
        return Ok(());
    };
    let pos = *monitor.position();
    let size = *monitor.size();
    let win = win.clone();
    let _ = win.clone().run_on_main_thread(move || {
        // The closure returns `()`, so every failure is logged rather than
        // propagated — do not introduce `?` in here.
        if let Err(e) = win.set_position(tauri::Position::Physical(pos)) {
            tracing::warn!(%e, label = win.label(), "annotation: set_position failed");
        }
        if let Err(e) = win.set_size(tauri::Size::Physical(size)) {
            tracing::warn!(%e, label = win.label(), "annotation: set_size failed");
        }
        if win.is_visible().unwrap_or(false) {
            set_follows_spaces(&win, true);
            apply_overlay_spaces(&win);
        }
    });
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
    // Deliberately does *not* reset `ANNOTATION_FOLLOW_DISPLAY`: a re-show while
    // the user has a pen armed must not resume hopping mid-stroke. The static
    // defaults to `true` for the genuine first show, `hide_annotation_overlay`
    // resets it for the next session, and `set_annotation_display_follow` is the
    // only other writer.
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
        tracing::info!("annotation: re-showing existing overlay");
        position_annotation_on_active_display(&app, &win)?;
        // `position_…` only re-asserts the policy when the window is already
        // visible, which it is not here — so apply it explicitly before showing.
        let w = win.clone();
        let _ = win.clone().run_on_main_thread(move || {
            set_follows_spaces(&w, true);
            apply_overlay_spaces(&w);
        });
        win.show()?;
        if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
            tracing::info!(
                x = pos.x,
                y = pos.y,
                w = size.width,
                h = size.height,
                "annotation: shown"
            );
        }
        let _ = app.emit(ANNOTATION_VISIBILITY_EVENT, true);
        arm_annotation_escape(&app);
        start_annotation_display_follow(&app);
        raise_recording_chrome(&app);
        return Ok(());
    }

    tracing::info!("annotation: creating overlay window");
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
    // `ns_window()` only exists once `build()` has returned, so the Spaces policy
    // has to be applied here rather than through the builder.
    let w = win.clone();
    let _ = win.clone().run_on_main_thread(move || {
        set_follows_spaces(&w, true);
        apply_overlay_spaces(&w);
    });
    win.show()?;
    if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
        tracing::info!(
            x = pos.x,
            y = pos.y,
            w = size.width,
            h = size.height,
            "annotation: created and shown"
        );
    }
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
    // Next show starts following again; the WebView re-reports on mount when a
    // tool is armed. Resetting on hide (not show) means a re-show mid-draw
    // cannot yank the canvas out from under the stroke.
    ANNOTATION_FOLLOW_DISPLAY.store(true, Ordering::Relaxed);
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
        "Capptivo Library",
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

    #[test]
    fn overlay_bits_reach_fullscreen_spaces() {
        let got = fullscreen_bits::with_overlay_spaces(0);
        // Both bits are required: Auxiliary to enter a fullscreen app's Space,
        // CanJoinAllSpaces to be present on every standard Space.
        assert_ne!(got & fullscreen_bits::AUXILIARY, 0);
        assert_ne!(got & fullscreen_bits::CAN_JOIN_ALL_SPACES, 0);
        // Primary would give the overlay its own Space instead of floating.
        assert_eq!(got & fullscreen_bits::PRIMARY, 0);
    }

    #[test]
    fn overlay_bits_clear_primary_when_already_set() {
        let existing = fullscreen_bits::PRIMARY | fullscreen_bits::DISALLOWS_TILING;
        let got = fullscreen_bits::with_overlay_spaces(existing);
        assert_eq!(got & fullscreen_bits::PRIMARY, 0);
        assert_eq!(got & fullscreen_bits::DISALLOWS_TILING, 0);
        assert_ne!(got & fullscreen_bits::AUXILIARY, 0);
    }

    /// AppKit treats `CanJoinAllSpaces` and `MoveToActiveSpace` as mutually
    /// exclusive, and hiding the overlay can leave the latter set.
    #[test]
    fn overlay_bits_drop_move_to_active_space() {
        let got = fullscreen_bits::with_overlay_spaces(fullscreen_bits::MOVE_TO_ACTIVE_SPACE);
        assert_eq!(got & fullscreen_bits::MOVE_TO_ACTIVE_SPACE, 0);
        assert_ne!(got & fullscreen_bits::CAN_JOIN_ALL_SPACES, 0);
    }

    #[test]
    fn overlay_bits_preserve_unrelated_bits() {
        const MANAGED: usize = 1 << 2;
        assert_eq!(
            fullscreen_bits::with_overlay_spaces(MANAGED) & MANAGED,
            MANAGED
        );
    }

    #[test]
    fn overlay_and_native_fullscreen_policies_are_disjoint() {
        // Guard rail: the editor shells' policy and the overlay's policy must
        // never converge. If someone "simplifies" these into one function, this
        // test fails.
        let overlay = fullscreen_bits::with_overlay_spaces(0);
        let shell = fullscreen_bits::with_native_fullscreen(0);
        assert_ne!(overlay & fullscreen_bits::AUXILIARY, 0);
        assert_eq!(shell & fullscreen_bits::AUXILIARY, 0);
        assert_eq!(overlay & fullscreen_bits::PRIMARY, 0);
        assert_ne!(shell & fullscreen_bits::PRIMARY, 0);
    }
}

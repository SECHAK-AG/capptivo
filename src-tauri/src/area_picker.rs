//! Full-screen region picker for partial-display capture.
//!
//! ponytail: picker is one transparent overlay spanning the virtual desktop;
//! the post-pick guide is a small click-through border window sized to the crop
//! (fullscreen dim WebViews freeze Windows). Crop coords are display-local in
//! the same space scap/WGC use for source rects.

use crate::error::{AppError, AppResult};
use crate::recorder::types::{CaptureAreaSelection, CaptureCrop};
#[cfg(target_os = "macos")]
use crate::recorder::backend::picker_sources;
#[cfg(target_os = "macos")]
use core_graphics::display::CGDisplay;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;

pub const AREA_PICKER_LABEL: &str = "area-picker";
pub const AREA_FRAME_LABEL: &str = "area-frame";

/// Outset so the CSS border isn’t clipped by the HWND.
const FRAME_OUTSET: f64 = 3.0;

/// Bumped on every show/hide so a deferred Windows create can’t resurrect a
/// guide the user already dismissed (or a newer show replaced).
static FRAME_EPOCH: AtomicU64 = AtomicU64::new(0);

struct VirtualDesktop {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy)]
struct FrameBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

pub struct AreaPickState {
    pub pending: parking_lot::Mutex<Option<mpsc::Sender<Option<CaptureAreaSelection>>>>,
}

impl AreaPickState {
    pub fn new() -> Self {
        Self {
            pending: parking_lot::Mutex::new(None),
        }
    }
}

pub async fn pick_capture_area(
    app: AppHandle,
    pick_state: tauri::State<'_, AreaPickState>,
) -> AppResult<CaptureAreaSelection> {
    let (tx, rx) = mpsc::channel();
    *pick_state.pending.lock() = Some(tx);

    if let Some(win) = app.get_webview_window(crate::windows::RECORDER_LABEL) {
        let _ = win.hide();
    }

    if let Err(e) = open_area_picker_window(&app) {
        pick_state.pending.lock().take();
        finish_area_pick(&app);
        return Err(e);
    }

    let result = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| AppError::Other(format!("area picker task failed: {e}")))?;

    match result {
        Ok(Some(sel)) => Ok(sel),
        Ok(None) => Err(AppError::Other("area selection cancelled".into())),
        Err(_) => Err(AppError::Other("area picker closed unexpectedly".into())),
    }
}

pub fn complete_area_pick(
    app: &AppHandle,
    pick_state: &AreaPickState,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<()> {
    let vd = virtual_desktop(app)?;
    let selection = resolve_selection(vd.x + x, vd.y + y, width, height, app)?;
    finish_area_pick(app);
    if let Some(tx) = pick_state.pending.lock().take() {
        let _ = tx.send(Some(selection));
    }
    Ok(())
}

pub fn cancel_area_pick(app: &AppHandle, pick_state: &AreaPickState) {
    finish_area_pick(app);
    if let Some(tx) = pick_state.pending.lock().take() {
        let _ = tx.send(None);
    }
}

fn open_area_picker_window(app: &AppHandle) -> AppResult<()> {
    let vd = virtual_desktop(app)?;

    if let Some(win) = app.get_webview_window(AREA_PICKER_LABEL) {
        apply_picker_geometry(&win, &vd)?;
        // Clear the previous drag chrome *before* show — otherwise the reused
        // WebView paints the last rect for a frame (flash of the old zone).
        let _ = win.emit("area-picker://reset", ());
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.set_always_on_top(true);
        return Ok(());
    }

    let win = crate::webview_gpu::apply_gpu_args(
        WebviewWindowBuilder::new(
            app,
            AREA_PICKER_LABEL,
            WebviewUrl::App("area.html".into()),
        )
        .title("Select area")
        .inner_size(vd.width, vd.height)
        .position(vd.x, vd.y)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .accept_first_mouse(true)
        .skip_taskbar(true)
        .visible(true),
    )
    .build()
    .map_err(|e| AppError::Other(format!("failed to open area picker: {e}")))?;

    apply_picker_geometry(&win, &vd)?;
    let _ = win.set_focus();

    Ok(())
}

fn apply_picker_geometry(
    win: &tauri::WebviewWindow,
    vd: &VirtualDesktop,
) -> AppResult<()> {
    let scale = win
        .scale_factor()
        .map_err(|e| AppError::Other(format!("scale factor: {e}")))?;

    let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(vd.width, vd.height)));
    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(vd.x, vd.y)));
    let _ = win.set_position(tauri::Position::Physical(PhysicalPosition::new(
        (vd.x * scale) as i32,
        (vd.y * scale) as i32,
    )));
    let _ = win.set_size(tauri::Size::Physical(PhysicalSize::new(
        (vd.width * scale) as u32,
        (vd.height * scale) as u32,
    )));
    Ok(())
}

/// Hide picker and bring back the recorder bar — only when pick ends.
fn finish_area_pick(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(AREA_PICKER_LABEL) {
        // Drop React drag state while hidden so the next open cannot flash it.
        let _ = win.emit("area-picker://reset", ());
        let _ = win.hide();
    }
    crate::windows::reveal_recorder_bar(app);
}

fn virtual_desktop(app: &AppHandle) -> AppResult<VirtualDesktop> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return windows_virtual_desktop();
    }
    #[cfg(not(target_os = "windows"))]
    {
        tauri_virtual_desktop(app)
    }
}

#[cfg(not(target_os = "windows"))]
fn tauri_virtual_desktop(app: &AppHandle) -> AppResult<VirtualDesktop> {
    let monitors = app
        .available_monitors()
        .map_err(|e| AppError::Other(format!("monitors: {e}")))?;
    if monitors.is_empty() {
        return Err(AppError::Other("no displays found".into()));
    }

    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;

    for m in monitors {
        let scale = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        let x = pos.x as f64 / scale;
        let y = pos.y as f64 / scale;
        let w = size.width as f64 / scale;
        let h = size.height as f64 / scale;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + w);
        max_y = max_y.max(y + h);
    }

    Ok(VirtualDesktop {
        x: min_x,
        y: min_y,
        width: (max_x - min_x).max(1.0),
        height: (max_y - min_y).max(1.0),
    })
}

/// Windows: same Win32/`windows-capture` monitors as WGC crop conversion.
#[cfg(target_os = "windows")]
fn windows_virtual_desktop() -> AppResult<VirtualDesktop> {
    let monitors = windows_logical_monitors();
    if monitors.is_empty() {
        return Err(AppError::Other("no displays found".into()));
    }

    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    for (_, x, y, w, h) in &monitors {
        min_x = min_x.min(*x);
        min_y = min_y.min(*y);
        max_x = max_x.max(x + w);
        max_y = max_y.max(y + h);
    }

    Ok(VirtualDesktop {
        x: min_x,
        y: min_y,
        width: (max_x - min_x).max(1.0),
        height: (max_y - min_y).max(1.0),
    })
}

/// Map a top-left logical rect (picker window space) to `display:{id}` + crop.
fn resolve_selection(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    app: &AppHandle,
) -> AppResult<CaptureAreaSelection> {
    const MIN: f64 = 48.0;
    if width < MIN || height < MIN {
        return Err(AppError::Other(format!(
            "selection too small (min {MIN:.0}×{MIN:.0} pt)"
        )));
    }

    let cx = x + width / 2.0;
    let cy = y + height / 2.0;

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return resolve_selection_windows(cx, cy, x, y, width, height, MIN);
    }
    #[cfg(target_os = "macos")]
    {
        resolve_selection_tauri(app, cx, cy, x, y, width, height, MIN)
    }
}

#[cfg(target_os = "windows")]
fn resolve_selection_windows(
    cx: f64,
    cy: f64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    min: f64,
) -> AppResult<CaptureAreaSelection> {
    for (id, mx, my, mw, mh) in windows_logical_monitors() {
        if cx < mx || cx >= mx + mw || cy < my || cy >= my + mh {
            continue;
        }

        let mut crop_x = x - mx;
        let mut crop_y = y - my;
        let mut crop_w = width;
        let mut crop_h = height;

        if crop_x < 0.0 {
            crop_w += crop_x;
            crop_x = 0.0;
        }
        if crop_y < 0.0 {
            crop_h += crop_y;
            crop_y = 0.0;
        }
        if crop_x + crop_w > mw {
            crop_w = mw - crop_x;
        }
        if crop_y + crop_h > mh {
            crop_h = mh - crop_y;
        }

        if crop_w < min || crop_h < min {
            return Err(AppError::Other("selection too small after clamping".into()));
        }

        let selection = CaptureAreaSelection {
            source_id: format!("display:{id}"),
            crop: CaptureCrop {
                x: crop_x,
                y: crop_y,
                width: crop_w,
                height: crop_h,
            },
        };
        tracing::info!(
            source_id = %selection.source_id,
            crop_x = selection.crop.x,
            crop_y = selection.crop.y,
            crop_w = selection.crop.width,
            crop_h = selection.crop.height,
            monitor_w = mw,
            monitor_h = mh,
            "area selection resolved (Win32 geometry)"
        );
        return Ok(selection);
    }

    Err(AppError::InvalidSource(
        "selection is outside all displays".into(),
    ))
}

#[cfg(target_os = "macos")]
fn resolve_selection_tauri(
    app: &AppHandle,
    cx: f64,
    cy: f64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    min: f64,
) -> AppResult<CaptureAreaSelection> {
    let monitors = app
        .available_monitors()
        .map_err(|e| AppError::Other(format!("monitors: {e}")))?;

    for m in monitors {
        let scale = m.scale_factor();
        let mx = m.position().x as f64 / scale;
        let my = m.position().y as f64 / scale;
        let mw = m.size().width as f64 / scale;
        let mh = m.size().height as f64 / scale;

        if cx < mx || cx >= mx + mw || cy < my || cy >= my + mh {
            continue;
        }

        let source_id = match_display_source(mx, my, mw, mh)?;
        let mut crop_x = x - mx;
        let mut crop_y = y - my;
        let mut crop_w = width;
        let mut crop_h = height;

        if crop_x < 0.0 {
            crop_w += crop_x;
            crop_x = 0.0;
        }
        if crop_y < 0.0 {
            crop_h += crop_y;
            crop_y = 0.0;
        }
        if crop_x + crop_w > mw {
            crop_w = mw - crop_x;
        }
        if crop_y + crop_h > mh {
            crop_h = mh - crop_y;
        }

        if crop_w < min || crop_h < min {
            return Err(AppError::Other("selection too small after clamping".into()));
        }

        let selection = CaptureAreaSelection {
            source_id,
            crop: CaptureCrop {
                x: crop_x,
                y: crop_y,
                width: crop_w,
                height: crop_h,
            },
        };
        tracing::info!(
            source_id = %selection.source_id,
            crop_x = selection.crop.x,
            crop_y = selection.crop.y,
            crop_w = selection.crop.width,
            crop_h = selection.crop.height,
            monitor_w = mw,
            monitor_h = mh,
            scale,
            "area selection resolved"
        );
        return Ok(selection);
    }

    Err(AppError::InvalidSource(
        "selection is outside all displays".into(),
    ))
}

/// Map a logical monitor rect (Tauri space) to the backend's `display:{id}`
/// source id. macOS only — Windows resolve walks Win32 monitors directly.
#[cfg(target_os = "macos")]
fn match_display_source(mx: f64, my: f64, mw: f64, mh: f64) -> AppResult<String> {
    let mut best: Option<(u32, f64)> = None;
    for (id, _) in picker_sources::list_displays()? {
        let b = CGDisplay::new(id).bounds();
        let overlap = rect_overlap(mx, my, mw, mh, b.origin.x, b.origin.y, b.size.width, b.size.height);
        if overlap > 0.0 {
            let prev = best.map(|(_, o)| o).unwrap_or(0.0);
            if overlap > prev {
                best = Some((id, overlap));
            }
        }
    }
    best.map(|(id, _)| format!("display:{id}"))
        .ok_or_else(|| AppError::InvalidSource("no display matched selection".into()))
}

/// Every monitor as `(hmonitor, logical x/y/w/h)` — same space as WGC crop.
#[cfg(target_os = "windows")]
fn windows_logical_monitors() -> Vec<(isize, f64, f64, f64, f64)> {
    crate::recorder::backend::win_preview::logical_monitors()
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

/// Click-through border around the crop. Sized to the selection only — a
/// fullscreen dim WebView was freezing Windows (GPU + input sink).
///
/// New WebView creation is deferred (`defer_on_ui`) — same Windows WebView2
/// rule as camera/library/editor (blank HWND if built inside sync IPC).
pub fn show_area_frame_guide(app: &AppHandle, selection: &CaptureAreaSelection) -> AppResult<()> {
    let epoch = FRAME_EPOCH.fetch_add(1, Ordering::AcqRel) + 1;
    let bounds = selection_frame_bounds(app, selection)?;

    if let Some(win) = app.get_webview_window(AREA_FRAME_LABEL) {
        apply_frame_geometry(&win, &bounds)?;
        return present_area_frame(app, &win, selection, &bounds);
    }

    let selection = selection.clone();
    let app = app.clone();
    crate::windows::defer_on_ui(app, move |app| {
        if FRAME_EPOCH.load(Ordering::Acquire) != epoch {
            return;
        }
        if let Err(e) = create_and_present_area_frame(app, &selection, epoch) {
            tracing::warn!(%e, "area frame guide: create failed");
        }
    });
    Ok(())
}

fn create_and_present_area_frame(
    app: &AppHandle,
    selection: &CaptureAreaSelection,
    epoch: u64,
) -> AppResult<()> {
    if FRAME_EPOCH.load(Ordering::Acquire) != epoch {
        return Ok(());
    }
    let bounds = selection_frame_bounds(app, selection)?;
    // Race: another deferred create may have won.
    if app.get_webview_window(AREA_FRAME_LABEL).is_none() {
        let win = crate::webview_gpu::apply_gpu_args(
            WebviewWindowBuilder::new(
                app,
                AREA_FRAME_LABEL,
                WebviewUrl::App("frame.html".into()),
            )
            .title("Area guide")
            .inner_size(bounds.width, bounds.height)
            .position(bounds.x, bounds.y)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false),
        )
        .build()
        .map_err(|e| AppError::Other(format!("failed to open area frame: {e}")))?;
        apply_frame_geometry(&win, &bounds)?;
    } else if let Some(win) = app.get_webview_window(AREA_FRAME_LABEL) {
        apply_frame_geometry(&win, &bounds)?;
    }
    if FRAME_EPOCH.load(Ordering::Acquire) != epoch {
        // Don't bump epoch — a newer show/hide owns it. Just park if we raced
        // a hide that ran before the HWND existed.
        park_area_frame(app);
        return Ok(());
    }
    let Some(win) = app.get_webview_window(AREA_FRAME_LABEL) else {
        return Err(AppError::Other("area frame window missing after open".into()));
    };
    present_area_frame(app, &win, selection, &bounds)
}

fn present_area_frame(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
    selection: &CaptureAreaSelection,
    bounds: &FrameBounds,
) -> AppResult<()> {
    // Must be click-through: an interactive always-on-top frame eats the desktop.
    win.set_ignore_cursor_events(true).map_err(|e| {
        hide_area_frame_guide(app);
        AppError::Other(format!(
            "area guide could not enable click-through: {e}"
        ))
    })?;
    let _ = win.set_always_on_top(true);
    crate::windows::exclude_overlay_from_capture(win);
    let scale = win.scale_factor().unwrap_or(1.0);
    tracing::info!(
        source_id = %selection.source_id,
        crop_x = selection.crop.x,
        crop_y = selection.crop.y,
        crop_w = selection.crop.width,
        crop_h = selection.crop.height,
        frame_x = bounds.x,
        frame_y = bounds.y,
        frame_w = bounds.width,
        frame_h = bounds.height,
        scale,
        "area frame guide shown"
    );
    let _ = win.show();
    Ok(())
}

pub fn hide_area_frame_guide(app: &AppHandle) {
    FRAME_EPOCH.fetch_add(1, Ordering::AcqRel);
    park_area_frame(app);
}

fn park_area_frame(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(AREA_FRAME_LABEL) {
        let _ = win.hide();
        // Park off-screen so a transient show/reuse cannot flash the old crop.
        let _ = win.set_position(tauri::Position::Physical(PhysicalPosition::new(-10_000, -10_000)));
        let _ = win.set_size(tauri::Size::Physical(PhysicalSize::new(1, 1)));
    }
}

fn apply_frame_geometry(win: &tauri::WebviewWindow, bounds: &FrameBounds) -> AppResult<()> {
    let scale = win
        .scale_factor()
        .map_err(|e| AppError::Other(format!("scale factor: {e}")))?;
    let _ = win.set_size(tauri::Size::Physical(PhysicalSize::new(
        (bounds.width * scale).round().max(1.0) as u32,
        (bounds.height * scale).round().max(1.0) as u32,
    )));
    let _ = win.set_position(tauri::Position::Physical(PhysicalPosition::new(
        (bounds.x * scale).round() as i32,
        (bounds.y * scale).round() as i32,
    )));
    Ok(())
}

fn selection_frame_bounds(
    app: &AppHandle,
    sel: &CaptureAreaSelection,
) -> AppResult<FrameBounds> {
    let (mx, my) = monitor_origin_for_source(app, &sel.source_id)?;
    let c = sel.crop;
    Ok(frame_guide_bounds(mx + c.x, my + c.y, c.width, c.height))
}

/// Expand the crop rect so the on-screen border sits just outside the capture.
fn frame_guide_bounds(x: f64, y: f64, width: f64, height: f64) -> FrameBounds {
    FrameBounds {
        x: x - FRAME_OUTSET,
        y: y - FRAME_OUTSET,
        width: (width + FRAME_OUTSET * 2.0).max(1.0),
        height: (height + FRAME_OUTSET * 2.0).max(1.0),
    }
}

#[cfg(test)]
mod frame_guide_tests {
    use super::{frame_guide_bounds, FRAME_OUTSET};

    #[test]
    fn frame_guide_outsets_the_crop() {
        let b = frame_guide_bounds(100.0, 200.0, 640.0, 360.0);
        assert!((b.x - (100.0 - FRAME_OUTSET)).abs() < f64::EPSILON);
        assert!((b.y - (200.0 - FRAME_OUTSET)).abs() < f64::EPSILON);
        assert!((b.width - (640.0 + FRAME_OUTSET * 2.0)).abs() < f64::EPSILON);
        assert!((b.height - (360.0 + FRAME_OUTSET * 2.0)).abs() < f64::EPSILON);
    }
}

#[cfg(target_os = "windows")]
fn monitor_origin_for_source(_app: &AppHandle, source_id: &str) -> AppResult<(f64, f64)> {
    let Some(("display", id_str)) = source_id.split_once(':') else {
        return Err(AppError::InvalidSource(format!("expected display id, got {source_id}")));
    };
    let display_id: isize = id_str
        .parse()
        .map_err(|_| AppError::InvalidSource(format!("bad display id: {id_str}")))?;
    windows_logical_monitors()
        .into_iter()
        .find(|(id, ..)| *id == display_id)
        .map(|(_, x, y, ..)| (x, y))
        .ok_or_else(|| AppError::InvalidSource("no monitor for display".into()))
}

#[cfg(target_os = "macos")]
fn monitor_origin_for_source(app: &AppHandle, source_id: &str) -> AppResult<(f64, f64)> {
    let Some(("display", id_str)) = source_id.split_once(':') else {
        return Err(AppError::InvalidSource(format!("expected display id, got {source_id}")));
    };
    let display_id: u32 = id_str
        .parse()
        .map_err(|_| AppError::InvalidSource(format!("bad display id: {id_str}")))?;
    let b = CGDisplay::new(display_id).bounds();

    let monitors = app
        .available_monitors()
        .map_err(|e| AppError::Other(format!("monitors: {e}")))?;

    let mut best: Option<(f64, f64, f64)> = None;
    for m in monitors {
        let scale = m.scale_factor();
        let mx = m.position().x as f64 / scale;
        let my = m.position().y as f64 / scale;
        let mw = m.size().width as f64 / scale;
        let mh = m.size().height as f64 / scale;
        let overlap = rect_overlap(mx, my, mw, mh, b.origin.x, b.origin.y, b.size.width, b.size.height);
        if overlap > 0.0 {
            let prev = best.map(|(_, _, o)| o).unwrap_or(0.0);
            if overlap > prev {
                best = Some((mx, my, overlap));
            }
        }
    }

    best.map(|(mx, my, _)| (mx, my))
        .ok_or_else(|| AppError::InvalidSource("no monitor for display".into()))
}

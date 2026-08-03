//! Full-screen region picker for partial-display capture.
//!
//! ponytail: one transparent overlay spanning the virtual desktop; crop coords are
//! display-local in the same space scap passes to SCK `sourceRect`.

use crate::error::{AppError, AppResult};
use crate::recorder::types::{CaptureAreaSelection, CaptureCrop};
#[cfg(target_os = "macos")]
use crate::recorder::backend::picker_sources;
#[cfg(target_os = "macos")]
use core_graphics::display::CGDisplay;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use std::sync::mpsc;

pub const AREA_PICKER_LABEL: &str = "area-picker";
pub const AREA_FRAME_LABEL: &str = "area-frame";

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaFrameRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

struct VirtualDesktop {
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
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.set_always_on_top(true);
        let _ = win.emit("area-picker://reset", ());
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
        let _ = win.hide();
    }
    crate::windows::reveal_recorder_bar(app);
}

fn virtual_desktop(app: &AppHandle) -> AppResult<VirtualDesktop> {
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

/// Map a top-left logical rect (Tauri monitor space) to `display:{id}` + crop.
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

        // Clamp to the monitor / display bounds.
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

        if crop_w < MIN || crop_h < MIN {
            return Err(AppError::Other("selection too small after clamping".into()));
        }

        return Ok(CaptureAreaSelection {
            source_id,
            crop: CaptureCrop {
                x: crop_x,
                y: crop_y,
                width: crop_w,
                height: crop_h,
            },
        });
    }

    Err(AppError::InvalidSource("selection is outside all displays".into()))
}

/// Map a logical monitor rect (Tauri space) to the backend's `display:{id}`
/// source id. This is the one genuinely per-OS piece of the picker: everything
/// else runs on Tauri's monitor APIs.
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

#[cfg(target_os = "windows")]
fn match_display_source(mx: f64, my: f64, mw: f64, mh: f64) -> AppResult<String> {
    let mut best: Option<(isize, f64)> = None;
    for (id, lx, ly, lw, lh) in windows_logical_monitors() {
        let overlap = rect_overlap(mx, my, mw, mh, lx, ly, lw, lh);
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

/// Every monitor as `(hmonitor, logical x/y/w/h)` — the same logical space the
/// picker geometry above is computed in.
#[cfg(target_os = "windows")]
fn windows_logical_monitors() -> Vec<(isize, f64, f64, f64, f64)> {
    use crate::recorder::backend::win_preview;
    use windows::Win32::Graphics::Gdi::HMONITOR;

    let Ok(monitors) = windows_capture::monitor::Monitor::enumerate() else {
        return Vec::new();
    };
    monitors
        .into_iter()
        .filter_map(|m| {
            let id = m.as_raw_hmonitor() as isize;
            let hmonitor = HMONITOR(m.as_raw_hmonitor());
            let rect = win_preview::monitor_rect(hmonitor)?;
            let scale = win_preview::monitor_scale(hmonitor);
            Some((
                id,
                rect.x / scale,
                rect.y / scale,
                rect.width / scale,
                rect.height / scale,
            ))
        })
        .collect()
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

/// Click-through dim + border so the user sees the crop bounds (not in the encode).
pub fn show_area_frame_guide(app: &AppHandle, selection: &CaptureAreaSelection) -> AppResult<()> {
    let vd = virtual_desktop(app)?;
    let rect = selection_to_window_rect(app, selection, &vd)?;
    open_area_frame_window(app, &vd)?;
    if let Some(win) = app.get_webview_window(AREA_FRAME_LABEL) {
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.set_always_on_top(true);
        let _ = win.show();
        let _ = win.emit("area-frame://rect", &rect);
        // Re-emit once the frame WebView has mounted (first open race).
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if let Some(win) = app2.get_webview_window(AREA_FRAME_LABEL) {
                let _ = win.emit("area-frame://rect", &rect);
            }
        });
    }
    Ok(())
}

pub fn hide_area_frame_guide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(AREA_FRAME_LABEL) {
        let _ = win.hide();
    }
}

fn open_area_frame_window(app: &AppHandle, vd: &VirtualDesktop) -> AppResult<()> {
    if let Some(win) = app.get_webview_window(AREA_FRAME_LABEL) {
        apply_picker_geometry(&win, vd)?;
        return Ok(());
    }

    let win = crate::webview_gpu::apply_gpu_args(
        WebviewWindowBuilder::new(
            app,
            AREA_FRAME_LABEL,
            WebviewUrl::App("frame.html".into()),
        )
        .title("Area guide")
        .inner_size(vd.width, vd.height)
        .position(vd.x, vd.y)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false),
    )
    .build()
    .map_err(|e| AppError::Other(format!("failed to open area frame: {e}")))?;

    apply_picker_geometry(&win, &vd)?;
    let _ = win.set_ignore_cursor_events(true);
    Ok(())
}

fn selection_to_window_rect(
    app: &AppHandle,
    sel: &CaptureAreaSelection,
    vd: &VirtualDesktop,
) -> AppResult<AreaFrameRect> {
    let (mx, my) = monitor_origin_for_source(app, &sel.source_id)?;
    let c = sel.crop;
    Ok(AreaFrameRect {
        x: mx + c.x - vd.x,
        y: my + c.y - vd.y,
        width: c.width,
        height: c.height,
    })
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

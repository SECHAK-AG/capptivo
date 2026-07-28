//! Picker thumbnails + monitor geometry via Win32 — the Windows sibling of
//! [`super::source_preview`]. One still frame per display (GDI `BitBlt`) or
//! window (`PrintWindow`), downscaled and PNG-encoded by [`super::preview`].

use super::preview::{encode_bgra, SourcePreview};
use crate::cursor::CaptureRect;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
    DIB_RGB_COLORS, HMONITOR, MONITORINFO, SRCCOPY,
};
// PrintWindow is grouped with the printing APIs in windows-rs, not USER32,
// and the (undocumented) full-content flag lives in WindowsAndMessaging as a
// bare u32 — bridge the two here.
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::PW_RENDERFULLCONTENT;
use windows_capture::monitor::Monitor;
use windows_capture::window::Window;

/// Physical bounds of a monitor in virtual-desktop coordinates.
pub fn monitor_rect(hmonitor: HMONITOR) -> Option<CaptureRect> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetMonitorInfoW(hmonitor, &mut info) };
    if !ok.as_bool() {
        return None;
    }
    let r = info.rcMonitor;
    Some(CaptureRect {
        x: f64::from(r.left),
        y: f64::from(r.top),
        width: f64::from(r.right - r.left).max(1.0),
        height: f64::from(r.bottom - r.top).max(1.0),
    })
}

/// Effective DPI scale of a monitor (points → pixels), 1.0 on failure.
pub fn monitor_scale(hmonitor: HMONITOR) -> f64 {
    let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
    let hr = unsafe { GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    if hr.is_ok() && dpi_x > 0 {
        f64::from(dpi_x) / 96.0
    } else {
        1.0
    }
}

pub fn display_thumbnail(monitor: &Monitor) -> Option<SourcePreview> {
    let hmonitor = HMONITOR(monitor.as_raw_hmonitor());
    let rect = monitor_rect(hmonitor)?;
    let (w, h) = (rect.width as i32, rect.height as i32);

    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return None;
        }
        let result = (|| {
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            if mem_dc.is_invalid() {
                return None;
            }
            let bitmap = CreateCompatibleBitmap(screen_dc, w, h);
            let prev = SelectObject(mem_dc, bitmap.into());
            let blit = BitBlt(
                mem_dc,
                0,
                0,
                w,
                h,
                Some(screen_dc),
                rect.x as i32,
                rect.y as i32,
                SRCCOPY | CAPTUREBLT,
            );
            let preview = if blit.is_ok() {
                read_bitmap_bgra(mem_dc, bitmap, w, h)
                    .and_then(|raw| encode_bgra(&raw, w as u32, h as u32, (w as usize) * 4))
            } else {
                None
            };
            SelectObject(mem_dc, prev);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(mem_dc);
            preview
        })();
        ReleaseDC(None, screen_dc);
        result
    }
}

pub fn window_thumbnail(window: &Window) -> Option<SourcePreview> {
    let hwnd = HWND(window.as_raw_hwnd());
    let w = window.width().ok()?;
    let h = window.height().ok()?;
    if w <= 0 || h <= 0 {
        return None;
    }

    unsafe {
        let window_dc = GetDC(Some(hwnd));
        if window_dc.is_invalid() {
            return None;
        }
        let result = (|| {
            let mem_dc = CreateCompatibleDC(Some(window_dc));
            if mem_dc.is_invalid() {
                return None;
            }
            let bitmap = CreateCompatibleBitmap(window_dc, w, h);
            let prev = SelectObject(mem_dc, bitmap.into());
            // PW_RENDERFULLCONTENT captures DirectComposition surfaces
            // (browsers, electron apps) that plain BitBlt misses.
            let ok =
                PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
            let preview = if ok {
                read_bitmap_bgra(mem_dc, bitmap, w, h)
                    .and_then(|raw| encode_bgra(&raw, w as u32, h as u32, (w as usize) * 4))
            } else {
                None
            };
            SelectObject(mem_dc, prev);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(mem_dc);
            preview
        })();
        ReleaseDC(Some(hwnd), window_dc);
        result
    }
}

/// Copy a GDI bitmap's pixels out as top-down BGRA.
unsafe fn read_bitmap_bgra(
    dc: windows::Win32::Graphics::Gdi::HDC,
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    w: i32,
    h: i32,
) -> Option<Vec<u8>> {
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            // Negative height = top-down rows, matching the encoder's layout.
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut raw = vec![0u8; (w as usize) * (h as usize) * 4];
    let lines = GetDIBits(
        dc,
        bitmap,
        0,
        h as u32,
        Some(raw.as_mut_ptr().cast()),
        &mut info,
        DIB_RGB_COLORS,
    );
    if lines == h {
        Some(raw)
    } else {
        None
    }
}

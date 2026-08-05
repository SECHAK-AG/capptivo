//! Picker thumbnails: one still frame per display/window.
//!
//! Primary path is `SCScreenshotManager` — the legacy Quartz screenshot APIs
//! (`CGDisplayCreateImage` / `CGWindowListCreateImage`) silently return NULL
//! on macOS 15+, which left the picker with blank numbered tiles. The Quartz
//! path is kept as the fallback for macOS < 14.4, where the manager class
//! doesn't exist.

use super::picker_sources::{
    display_scale_factor, display_for_window_frame, points_to_even_pixels,
};
use super::preview::{SourcePreview, PREVIEW_MAX_WIDTH};
use crate::cursor::CaptureRect;
use base64::{engine::general_purpose::STANDARD, Engine};
use block::ConcreteBlock;
use core_graphics::display::CGDisplay;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::image::CGImageRef;
use core_graphics::window::{
    create_image, kCGNullWindowID, kCGWindowImageBoundsIgnoreFraming,
    kCGWindowImageBestResolution, kCGWindowListOptionIncludingWindow,
    kCGWindowListOptionOnScreenOnly,
};
use foreign_types::ForeignTypeRef;
use image::{ImageBuffer, ImageFormat, RgbaImage};
use objc::runtime::{Class, Object, BOOL, NO};
use objc::{class, msg_send, sel, sel_impl};
use objc_id::Id;
use screencapturekit_sys::content_filter::{UnsafeContentFilter, UnsafeInitParams};
use screencapturekit_sys::shareable_content::UnsafeSCShareableContent;
use std::io::Cursor;
use std::sync::mpsc;
use std::time::Duration;

const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(3);

fn sck_available() -> bool {
    Class::get("SCScreenshotManager").is_some()
}

pub fn display_thumbnail(display_id: u32) -> Option<SourcePreview> {
    if !sck_available() {
        return legacy_display_thumbnail(display_id);
    }
    let content = UnsafeSCShareableContent::get().ok()?;
    let display = content
        .displays()
        .into_iter()
        .find(|d| d.get_display_id() == display_id)?;
    let frame = display.get_frame();
    let (w, h) = points_to_even_pixels(
        frame.size.width,
        frame.size.height,
        display_scale_factor(display_id),
    );
    let filter = UnsafeContentFilter::init(UnsafeInitParams::Display(display));
    sck_screenshot(filter, w, h)
}

pub fn window_thumbnail(window_id: u32) -> Option<SourcePreview> {
    if !sck_available() {
        return legacy_window_thumbnail(window_id);
    }
    let content = UnsafeSCShareableContent::get().ok()?;
    let displays = content.displays();
    let window = content
        .windows()
        .into_iter()
        .find(|w| w.get_window_id() == window_id)?;
    let frame = window.get_frame();
    let rect = CaptureRect {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    };
    let scale = display_for_window_frame(&rect, &displays)
        .map(display_scale_factor)
        .unwrap_or(1);
    let (w, h) = points_to_even_pixels(rect.width, rect.height, scale);
    let filter =
        UnsafeContentFilter::init(UnsafeInitParams::DesktopIndependentWindow(window));
    sck_screenshot(filter, w, h)
}

/// One frame through `SCScreenshotManager`. The completion handler lands on an
/// SCK-internal queue, so blocking on the channel here is safe from any thread.
fn sck_screenshot(
    filter: Id<UnsafeContentFilter>,
    width_px: u32,
    height_px: u32,
) -> Option<SourcePreview> {
    let (tx, rx) = mpsc::channel::<Option<SourcePreview>>();
    unsafe {
        let config: *mut Object = msg_send![class!(SCStreamConfiguration), new];
        let _: () = msg_send![config, setWidth: width_px as usize];
        let _: () = msg_send![config, setHeight: height_px as usize];
        let _: () = msg_send![config, setShowsCursor: NO as BOOL];
        let handler = ConcreteBlock::new(move |image: *mut Object, _error: *mut Object| {
            let preview = if image.is_null() {
                None
            } else {
                encode_preview(CGImageRef::from_ptr(image.cast()))
            };
            let _ = tx.send(preview);
        })
        .copy();
        let _: () = msg_send![
            class!(SCScreenshotManager),
            captureImageWithFilter: &*filter
            configuration: config
            completionHandler: &*handler
        ];
        let _: () = msg_send![config, release];
    }
    rx.recv_timeout(SCREENSHOT_TIMEOUT).ok().flatten()
}

fn legacy_display_thumbnail(display_id: u32) -> Option<SourcePreview> {
    let display = CGDisplay::new(display_id);
    let bounds = display.bounds();
    let image = CGDisplay::screenshot(
        bounds,
        kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID,
        kCGWindowImageBestResolution,
    )?;
    encode_preview(&image)
}

fn legacy_window_thumbnail(window_id: u32) -> Option<SourcePreview> {
    // CGRectNull — required for single-window capture.
    let bounds = CGRect::new(
        &CGPoint::new(f64::INFINITY, f64::INFINITY),
        &CGSize::new(0.0, 0.0),
    );
    let image = create_image(
        bounds,
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution,
    )?;
    encode_preview(&image)
}

fn encode_preview(image: &CGImageRef) -> Option<SourcePreview> {
    let width = image.width() as u32;
    let height = image.height() as u32;
    if width == 0 || height == 0 {
        return None;
    }
    let png_base64 = png_base64(image)?;
    Some(SourcePreview {
        png_base64,
    })
}

fn png_base64(image: &CGImageRef) -> Option<String> {
    let w = image.width() as u32;
    let h = image.height() as u32;
    let tw = PREVIEW_MAX_WIDTH.min(w).max(1);
    let th = ((h as u64 * tw as u64) / w as u64).max(1) as u32;
    let stride = image.bytes_per_row() as usize;
    let bpp = (image.bits_per_pixel() as usize / 8).max(1);
    let data = image.data();
    let raw = data.bytes();

    let mut rgba = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        let sy = (y as u64 * h as u64 / th as u64) as usize;
        for x in 0..tw {
            let sx = (x as u64 * w as u64 / tw as u64) as usize;
            let i = sy * stride + sx * bpp;
            if i + bpp > raw.len() {
                continue;
            }
            let o = ((y * tw + x) * 4) as usize;
            match bpp {
                4 => {
                    rgba[o] = raw[i + 2];
                    rgba[o + 1] = raw[i + 1];
                    rgba[o + 2] = raw[i];
                    rgba[o + 3] = raw[i + 3];
                }
                3 => {
                    rgba[o] = raw[i];
                    rgba[o + 1] = raw[i + 1];
                    rgba[o + 2] = raw[i + 2];
                    rgba[o + 3] = 255;
                }
                _ => {}
            }
        }
    }

    let buf: RgbaImage = ImageBuffer::from_raw(tw, th, rgba)?;
    let mut out = Vec::new();
    buf.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).ok()?;
    Some(STANDARD.encode(out))
}

//! Picker thumbnails via Quartz — one still frame per display/window, no SCStream.

use super::preview::{SourcePreview, PREVIEW_MAX_WIDTH};
use base64::{engine::general_purpose::STANDARD, Engine};
use core_graphics::display::CGDisplay;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::image::CGImage;
use core_graphics::window::{
    create_image, kCGNullWindowID, kCGWindowImageBoundsIgnoreFraming,
    kCGWindowImageBestResolution, kCGWindowListOptionIncludingWindow,
    kCGWindowListOptionOnScreenOnly,
};
use image::{ImageBuffer, ImageFormat, RgbaImage};
use std::io::Cursor;

pub fn display_thumbnail(display_id: u32) -> Option<SourcePreview> {
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

pub fn window_thumbnail(window_id: u32) -> Option<SourcePreview> {
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

fn encode_preview(image: &CGImage) -> Option<SourcePreview> {
    let width = image.width() as u32;
    let height = image.height() as u32;
    if width == 0 || height == 0 {
        return None;
    }
    let png_base64 = png_base64(image)?;
    Some(SourcePreview {
        width,
        height,
        png_base64,
    })
}

fn png_base64(image: &CGImage) -> Option<String> {
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

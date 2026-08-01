//! Shared picker-thumbnail encoding: a raw BGRA buffer in, a small base64 PNG
//! out. Platform capture code (Quartz on macOS, GDI on Windows) only has to
//! produce pixels; the downscale + encode lives here once.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageBuffer, ImageFormat, RgbaImage};
use std::io::Cursor;

pub const PREVIEW_MAX_WIDTH: u32 = 240;

pub struct SourcePreview {
    pub png_base64: String,
}

/// Downscale a BGRA buffer (top-down rows, `stride` bytes per row) to a
/// `PREVIEW_MAX_WIDTH`-wide PNG and base64-encode it. `width`/`height` describe
/// the *source*; the returned preview reports the source dimensions so the
/// picker can show native resolution labels.
// macOS thumbnails go through CGImage (which can be 24-bit) instead of this.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn encode_bgra(raw: &[u8], width: u32, height: u32, stride: usize) -> Option<SourcePreview> {
    if width == 0 || height == 0 {
        return None;
    }
    let tw = PREVIEW_MAX_WIDTH.min(width).max(1);
    let th = ((height as u64 * tw as u64) / width as u64).max(1) as u32;

    let mut rgba = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        let sy = (y as u64 * height as u64 / th as u64) as usize;
        for x in 0..tw {
            let sx = (x as u64 * width as u64 / tw as u64) as usize;
            let i = sy * stride + sx * 4;
            if i + 4 > raw.len() {
                continue;
            }
            let o = ((y * tw + x) * 4) as usize;
            rgba[o] = raw[i + 2];
            rgba[o + 1] = raw[i + 1];
            rgba[o + 2] = raw[i];
            rgba[o + 3] = 255;
        }
    }

    let buf: RgbaImage = ImageBuffer::from_raw(tw, th, rgba)?;
    let mut out = Vec::new();
    buf.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).ok()?;
    Some(SourcePreview {
        png_base64: STANDARD.encode(out),
    })
}

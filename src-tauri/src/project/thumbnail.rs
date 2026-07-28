//! Library poster images. Written once at record-time from a live BGRA frame
//! (cheap). Older projects without a poster can be backfilled via a one-shot
//! FFmpeg extract of `screen.mp4` — still once, then the JPEG is reused forever.

use crate::error::{AppError, AppResult};
use crate::recorder::encoder::ffmpeg_path;
use image::{ImageBuffer, ImageFormat, RgbImage};
use std::path::Path;

pub const THUMBNAIL_FILE: &str = "thumbnail.jpg";
const THUMB_MAX_WIDTH: u32 = 480;

/// Downscale BGRA → JPEG. Nearest-neighbor keep it cheap on the encode thread.
pub fn write_from_bgra(
    path: &Path,
    width: u32,
    height: u32,
    bytes_per_row: u32,
    bgra: &[u8],
) -> AppResult<()> {
    if width == 0 || height == 0 {
        return Err(AppError::Encoder("empty frame for thumbnail".into()));
    }
    let stride = bytes_per_row as usize;
    let tight = (width as usize) * 4;
    if stride < tight {
        return Err(AppError::Encoder("invalid frame stride for thumbnail".into()));
    }

    let tw = THUMB_MAX_WIDTH.min(width).max(1);
    let th = ((height as u64 * tw as u64) / width as u64).max(1) as u32;
    let mut rgb = vec![0u8; (tw * th * 3) as usize];

    for y in 0..th {
        let sy = (y as u64 * height as u64 / th as u64) as usize;
        for x in 0..tw {
            let sx = (x as u64 * width as u64 / tw as u64) as usize;
            let i = sy * stride + sx * 4;
            if i + 3 >= bgra.len() {
                continue;
            }
            let o = ((y * tw + x) * 3) as usize;
            // BGRA → RGB
            rgb[o] = bgra[i + 2];
            rgb[o + 1] = bgra[i + 1];
            rgb[o + 2] = bgra[i];
        }
    }

    let img: RgbImage = ImageBuffer::from_raw(tw, th, rgb)
        .ok_or_else(|| AppError::Encoder("thumbnail buffer mismatch".into()))?;

    let tmp = path.with_extension("jpg.tmp");
    img.save_with_format(&tmp, ImageFormat::Jpeg)
        .map_err(|e| AppError::Encoder(format!("thumbnail jpeg write: {e}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Encoder(format!("thumbnail rename: {e}")))?;
    Ok(())
}

/// One-shot backfill for projects recorded before posters existed.
pub fn extract_from_mp4(screen_mp4: &Path, thumbnail_jpg: &Path) -> AppResult<()> {
    if !screen_mp4.exists() {
        return Err(AppError::Project("screen.mp4 missing".into()));
    }
    let ffmpeg = ffmpeg_path();
    let status = crate::proc::command(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            // Skip the often-black first frame of a fresh desktop capture.
            "-ss",
            "0.4",
            "-i",
        ])
        .arg(screen_mp4)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={THUMB_MAX_WIDTH}:-2"),
            "-q:v",
            "5",
        ])
        .arg(thumbnail_jpg)
        .status()
        .map_err(|e| AppError::Encoder(format!("thumbnail ffmpeg spawn: {e}")))?;

    if !status.success() || !thumbnail_jpg.exists() {
        return Err(AppError::Encoder(format!(
            "thumbnail ffmpeg failed ({status})"
        )));
    }
    Ok(())
}

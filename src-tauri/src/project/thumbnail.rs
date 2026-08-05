//! Library poster images. Written once at record-time from a live BGRA frame
//! (cheap). Older projects without a poster can be backfilled via a one-shot
//! FFmpeg extract of `screen.mp4` — still once, then the JPEG is reused forever.

use crate::error::{AppError, AppResult};
use crate::recorder::encoder::ffmpeg_path;
use image::{ImageBuffer, ImageFormat, RgbImage};
use std::path::Path;
use std::process::Stdio;

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
    let tmp = thumbnail_jpg.with_extension("jpg.tmp");
    let _ = std::fs::remove_file(&tmp);
    let ffmpeg = ffmpeg_path();
    // Backfill on a detached thread after a recording ends — no thread cap, it
    // decodes a single frame, but it should not compete with the foreground.
    let output = crate::proc::background_command(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
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
            // MJPEG only accepts the full-range `yuvj*` formats. Recordings are
            // limited-range `yuv420p`, and without this the encoder rejects the
            // frame outright and no poster is written.
            "-pix_fmt",
            "yuvj420p",
            "-q:v",
            "5",
            // `.jpg.tmp` is not a format FFmpeg recognizes; force image2 so we
            // can still stage+rename like `write_from_bgra`.
            "-f",
            "image2",
        ])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Piped, not inherited: this runs from a background backfill, so the
        // reason a poster is missing has to travel back in the error itself.
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| AppError::Encoder(format!("thumbnail ffmpeg spawn: {e}")))?;

    let wrote = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if !output.status.success() || wrote == 0 {
        let _ = std::fs::remove_file(&tmp);
        let detail = crate::proc::summarize_stderr(&output.stderr);
        return Err(AppError::Encoder(if detail.is_empty() {
            format!("thumbnail ffmpeg failed ({})", output.status)
        } else {
            format!("thumbnail ffmpeg failed ({}): {detail}", output.status)
        }));
    }
    std::fs::rename(&tmp, thumbnail_jpg)
        .map_err(|e| AppError::Encoder(format!("thumbnail rename: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_extract_leaves_no_partial_thumbnail() {
        let dir = std::env::temp_dir().join(format!(
            "capptivo-thumb-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("screen.mp4");
        let thumbnail_jpg = dir.join("thumbnail.jpg");
        std::fs::write(&fake, b"not an mp4").unwrap();

        let err = extract_from_mp4(&fake, &thumbnail_jpg);
        assert!(err.is_err(), "invalid mp4 must not produce a poster");
        assert!(
            !thumbnail_jpg.exists(),
            "final thumbnail must not exist after failure"
        );
        assert!(
            !thumbnail_jpg.with_extension("jpg.tmp").exists(),
            "staging jpg.tmp must not remain after failure"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

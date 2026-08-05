//! Preview proxy: a small, low-bitrate downscale of `screen.mp4` used for smooth
//! scrubbing/playback in the editor. The original is always what gets exported —
//! the proxy only ever backs the on-screen `<video>`.

use crate::error::{AppError, AppResult};
use crate::proc;
use crate::recorder::encoder::ffmpeg_path;
use crate::recorder::hw_encoder;
use std::path::{Path, PathBuf};

/// Proxy filename inside a project directory.
pub const PROXY_FILE: &str = "proxy.mp4";

/// The proxy fits inside this box (long edge), preserving aspect. 720p-class is
/// the sweet spot: far cheaper to decode/seek than 1080p+/4K originals, and the
/// compositor references 1920 for the actual export regardless.
const PROXY_LONG_EDGE: u32 = 1280;

/// Absolute proxy path for a project directory.
pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(PROXY_FILE)
}

/// Transcode `screen` into a preview proxy at `dir/proxy.mp4` (written atomically
/// via a temp file). Video is downscaled + re-encoded (probed hardware encoder) with frequent
/// keyframes for snappy seeking; audio is stream-copied so preview keeps its sound.
pub fn generate(screen: &Path, dir: &Path) -> AppResult<()> {
    if !screen.is_file() {
        return Err(AppError::Other("proxy: missing screen recording".into()));
    }

    let out = path_in(dir);
    let tmp = dir.join("proxy.tmp.mp4");
    let ffmpeg = ffmpeg_path();
    let encoder = hw_encoder::pick(&ffmpeg);
    // Fit inside a PROXY_LONG_EDGE² box, keep aspect, keep dimensions even.
    let scale = format!(
        "scale={PROXY_LONG_EDGE}:{PROXY_LONG_EDGE}:force_original_aspect_ratio=decrease:force_divisible_by=2"
    );

    // This runs on editor open, against the full-resolution recording, and
    // nobody is watching it — so it gets background priority and a bounded
    // thread pool. Left at FFmpeg's defaults it decodes 4K, scales, and
    // re-encodes on every core at normal priority, which is what made opening
    // the editor lock up the desktop. The cap is applied three times because
    // each stage sizes its own pool: decode (before `-i`), filtering, encode.
    let threads = proc::encode_thread_cap().to_string();

    let status = proc::background_command(&ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(["-filter_threads", &threads])
        .args(["-threads", &threads])
        .args(encoder.pre_input_args)
        .arg("-i")
        .arg(screen)
        .args(["-c:v", encoder.name])
        .args(encoder.output_args(Some(&scale)))
        .args(encoder.tuning_args)
        .args(["-threads", &threads])
        .args([
            "-b:v",
            "2500k",
            "-g",
            "30", // frequent keyframes → snappy scrubbing
            "-c:a",
            "copy", // keep the recorded audio for monitoring (no-op if silent)
            "-movflags",
            "+faststart",
        ])
        .arg(&tmp)
        .status()
        .map_err(|e| AppError::Other(format!("proxy ffmpeg spawn failed: {e}")))?;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Other(format!(
            "proxy transcode failed with {status}"
        )));
    }
    std::fs::rename(&tmp, &out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::Other(format!("proxy rename failed: {e}"))
    })
}

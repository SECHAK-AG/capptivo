//! Preview proxy: a small, low-bitrate downscale of `screen.mp4` used for smooth
//! scrubbing/playback in the editor. The original is always what gets exported —
//! the proxy only ever backs the on-screen `<video>`.

use crate::error::{AppError, AppResult};
use crate::proc;
use crate::recorder::encoder::ffmpeg_path;
use crate::recorder::hw_decoder::{self, DecodePlan};
use crate::recorder::hw_encoder::{self, EncoderChoice};
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
///
/// `source_size` is the recording's true pixel size from `meta.json`, used only
/// to size the GPU scalers that cannot fit-inside-a-box themselves (see
/// [`hw_decoder`]). `None` — or a size that could not be read — costs nothing
/// beyond those specific scalers.
///
/// Runs the GPU pipeline first where one exists for the probed encoder, and
/// re-runs on the CPU if it fails. See [`transcode`] for why that is a retry and
/// not a probe.
pub fn generate(screen: &Path, dir: &Path, source_size: Option<(u32, u32)>) -> AppResult<()> {
    if !screen.is_file() {
        return Err(AppError::Other("proxy: missing screen recording".into()));
    }

    let out = path_in(dir);
    let tmp = dir.join("proxy.tmp.mp4");
    let ffmpeg = ffmpeg_path();
    let encoder = hw_encoder::pick(&ffmpeg);

    // The GPU pipeline is attempted, not probed. A proxy transcode is a batch
    // job over a file that is still on disk afterwards, so re-running it on the
    // CPU is always available — which makes "try it and see" both cheaper than a
    // probe (no cost at all on the machines where it works) and more accurate
    // (it tests this recording on this driver, not a synthetic stand-in).
    // Hardware init failures surface in well under a second; the risk being
    // traded away is a rare late failure that costs one wasted partial encode.
    if let Some(plan) = hw_decoder::plan_for(encoder) {
        match plan.scale_filter(PROXY_LONG_EDGE, source_size) {
            Some(filter) => match transcode(&ffmpeg, screen, &tmp, encoder, Some((&plan, &filter)))
            {
                Ok(()) => {
                    tracing::info!(
                        hwaccel = plan.name,
                        encoder = encoder.name,
                        "preview proxy transcoded on the GPU"
                    );
                    return promote(&tmp, &out);
                }
                Err(e) => {
                    // INFO, not DEBUG: "why is opening the editor slow on my
                    // laptop" is only answerable from a shipped log if the GPU
                    // pipeline says when it bailed.
                    tracing::info!(
                        hwaccel = plan.name,
                        encoder = encoder.name,
                        reason = %e,
                        "GPU proxy pipeline failed; falling back to CPU decode"
                    );
                    let _ = std::fs::remove_file(&tmp);
                }
            },
            None => {
                tracing::info!(
                    hwaccel = plan.name,
                    "GPU proxy scaler needs the recording size and meta.json did not supply it"
                );
            }
        }
    }

    transcode(&ffmpeg, screen, &tmp, encoder, None)?;
    promote(&tmp, &out)
}

/// One FFmpeg transcode into `tmp`. `gpu` selects the zero-copy decode→scale
/// pipeline; `None` is the CPU decode + swscale path that works everywhere.
fn transcode(
    ffmpeg: &Path,
    screen: &Path,
    tmp: &Path,
    encoder: &EncoderChoice,
    gpu: Option<(&DecodePlan, &str)>,
) -> AppResult<()> {
    // This runs on editor open, against the full-resolution recording, and
    // nobody is watching it — so it gets background priority and a bounded
    // thread pool. Left at FFmpeg's defaults it decodes 4K, scales, and
    // re-encodes on every core at normal priority, which is what made opening
    // the editor lock up the desktop. The cap is applied three times because
    // each stage sizes its own pool: decode (before `-i`), filtering, encode.
    //
    // The cap stays on the GPU path too. It bounds what little CPU work is
    // left (demux, mux, the audio copy) and costs nothing there — the point of
    // the GPU pipeline is that those threads are no longer the limit.
    let threads = proc::encode_thread_cap().to_string();

    let mut cmd = proc::background_command(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(["-filter_threads", &threads])
        .args(["-threads", &threads])
        .args(encoder.pre_input_args);

    if let Some((plan, _)) = gpu {
        cmd.args(plan.pre_input_args);
    }

    cmd.arg("-i").arg(screen).args(["-c:v", encoder.name]);

    match gpu {
        // Frames are already on the GPU in the encoder's own format, so the
        // filter is the plan's scaler alone: `encoder.output_args` would append
        // VAAPI's `hwupload` (uploading what never left) or a `-pix_fmt` the
        // hardware frame does not have.
        Some((_, filter)) => {
            cmd.args(["-vf", filter]);
        }
        None => {
            // Fit inside a PROXY_LONG_EDGE² box, keep aspect, keep dimensions even.
            let scale = format!(
                "scale={PROXY_LONG_EDGE}:{PROXY_LONG_EDGE}:force_original_aspect_ratio=decrease:force_divisible_by=2"
            );
            cmd.args(encoder.output_args(Some(&scale)));
        }
    }

    let output = cmd
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
        .arg(tmp)
        .output()
        .map_err(|e| AppError::Other(format!("proxy ffmpeg spawn failed: {e}")))?;

    if !output.status.success() {
        // The stderr is the whole diagnosis when the GPU attempt is the one that
        // failed — a bare exit code would make the fallback untraceable.
        let detail = proc::summarize_stderr(&output.stderr);
        return Err(AppError::Other(if detail.is_empty() {
            format!("proxy transcode failed with {}", output.status)
        } else {
            format!("proxy transcode failed with {}: {detail}", output.status)
        }));
    }
    Ok(())
}

fn promote(tmp: &Path, out: &Path) -> AppResult<()> {
    std::fs::rename(tmp, out).map_err(|e| {
        let _ = std::fs::remove_file(tmp);
        AppError::Other(format!("proxy rename failed: {e}"))
    })
}

//! H.264 encoder selection. macOS always has VideoToolbox, but Windows and
//! Linux expose hardware encode through vendor-specific FFmpeg encoders — so the
//! choice is *probed* once per process (a 2-frame smoke encode against the null
//! muxer, ~100 ms) and cached. Every FFmpeg pipeline that encodes H.264
//! (recorder, preview proxy) consumes the same [`EncoderChoice`].

use crate::proc;
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;

/// One FFmpeg H.264 encoder plus the arg plumbing it needs. Fields are ordered
/// the way they appear on the command line:
/// `ffmpeg [pre_input_args] -i … -c:v {name} [output_args] [tuning_args] out`.
#[derive(Debug, Clone, Copy)]
pub struct EncoderChoice {
    pub name: &'static str,
    /// Global/input-side args (e.g. the VAAPI device) — before `-i`.
    pub pre_input_args: &'static [&'static str],
    /// Software pixel format handed to the encoder (`-pix_fmt`), when the
    /// encoder consumes CPU frames directly.
    pix_fmt: Option<&'static str>,
    /// Filter tail that uploads frames to the GPU (VAAPI). Mutually exclusive
    /// with `pix_fmt`; composed after any caller-supplied filter.
    upload_filter: Option<&'static str>,
    /// Encoder tuning (software x264 needs a fast preset to keep realtime).
    pub tuning_args: &'static [&'static str],
}

impl EncoderChoice {
    /// Output-side args after `-c:v {name}`: the `-vf` chain (caller filter +
    /// GPU upload) and/or `-pix_fmt`, whichever this encoder needs.
    pub fn output_args(&self, prefilter: Option<&str>) -> Vec<String> {
        let mut args = Vec::new();
        let filter = match (prefilter, self.upload_filter) {
            (Some(f), Some(up)) => Some(format!("{f},{up}")),
            (Some(f), None) => Some(f.to_string()),
            (None, Some(up)) => Some(up.to_string()),
            (None, None) => None,
        };
        if let Some(filter) = filter {
            args.push("-vf".into());
            args.push(filter);
        }
        if let Some(fmt) = self.pix_fmt {
            args.push("-pix_fmt".into());
            args.push(fmt.into());
        }
        args
    }
}

/// The always-available software encoder, shared as every platform's last resort.
const SOFTWARE_FALLBACK: EncoderChoice = EncoderChoice {
    name: "libx264",
    pre_input_args: &[],
    pix_fmt: Some("yuv420p"),
    upload_filter: None,
    tuning_args: &["-preset", "veryfast"],
};

/// Candidates in preference order per OS. The last entry must be the software
/// fallback so `pick()` can always return something.
fn candidates() -> &'static [EncoderChoice] {
    #[cfg(target_os = "macos")]
    {
        &[
            EncoderChoice {
                name: "h264_videotoolbox",
                pre_input_args: &[],
                pix_fmt: Some("yuv420p"),
                upload_filter: None,
                tuning_args: &[],
            },
            SOFTWARE_FALLBACK,
        ]
    }
    // `h264_mf` is deliberately absent. It is a Media Foundation wrapper: when a
    // hardware MFT exists, NVENC/QSV/AMF have already claimed it above; when one
    // does not, `h264_mf` falls back to its own software MFT, which is slower and
    // lower quality than `libx264 -preset veryfast` and takes no tuning
    // arguments. There is no machine on which it is the best remaining choice —
    // it only ever displaced a better fallback that sits one line below it.
    #[cfg(target_os = "windows")]
    {
        &[
            EncoderChoice {
                name: "h264_nvenc",
                pre_input_args: &[],
                pix_fmt: Some("yuv420p"),
                upload_filter: None,
                tuning_args: &[],
            },
            EncoderChoice {
                name: "h264_qsv",
                pre_input_args: &[],
                pix_fmt: Some("nv12"),
                upload_filter: None,
                tuning_args: &[],
            },
            EncoderChoice {
                name: "h264_amf",
                pre_input_args: &[],
                pix_fmt: Some("yuv420p"),
                upload_filter: None,
                tuning_args: &[],
            },
            SOFTWARE_FALLBACK,
        ]
    }
    #[cfg(target_os = "linux")]
    {
        &[
            EncoderChoice {
                name: "h264_vaapi",
                pre_input_args: &["-vaapi_device", "/dev/dri/renderD128"],
                pix_fmt: None,
                upload_filter: Some("format=nv12,hwupload"),
                tuning_args: &[],
            },
            EncoderChoice {
                name: "h264_nvenc",
                pre_input_args: &[],
                pix_fmt: Some("yuv420p"),
                upload_filter: None,
                tuning_args: &[],
            },
            SOFTWARE_FALLBACK,
        ]
    }
}

/// The probed encoder for this machine. First call runs the probes; later calls
/// return the cached pick.
pub fn pick(ffmpeg: &Path) -> &'static EncoderChoice {
    static PICK: OnceLock<&'static EncoderChoice> = OnceLock::new();
    PICK.get_or_init(|| select(ffmpeg))
}

/// The probe loop behind [`pick`], without the cache. Split out so the fallback
/// behaviour is testable — asserting on `pick` makes the result depend on
/// whichever test happened to warm the `OnceLock` first.
fn select(ffmpeg: &Path) -> &'static EncoderChoice {
    let all = candidates();
    for choice in all {
        match probe(ffmpeg, choice) {
            Ok(()) => {
                tracing::info!(encoder = choice.name, "selected H.264 encoder");
                return choice;
            }
            // INFO, not DEBUG: "why is my export slow on an RTX card" is only
            // answerable from a shipped log if the rejections are in it.
            Err(failure) => tracing::info!(
                encoder = choice.name,
                reason = %failure,
                "H.264 encoder unavailable"
            ),
        }
    }
    // Every hardware probe failed — software encode is the safe last resort.
    let fallback = all.last().unwrap_or(&SOFTWARE_FALLBACK);
    tracing::warn!(
        encoder = fallback.name,
        "all encoder probes failed; falling back to software encoder"
    );
    fallback
}

/// Why a candidate was rejected.
///
/// Worth distinguishing: [`Self::FfmpegUnavailable`] means the sidecar itself
/// could not be run, so *every* candidate is going to fail and the install is
/// broken; [`Self::Rejected`] means FFmpeg ran fine and refused this one
/// encoder, which is a driver or hardware question about that candidate alone.
/// Collapsing both into "probe failed" is what made slow-export reports
/// undiagnosable from a log.
#[derive(Debug)]
enum ProbeFailure {
    FfmpegUnavailable(String),
    Rejected(String),
}

impl std::fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FfmpegUnavailable(e) => write!(f, "ffmpeg could not be started: {e}"),
            Self::Rejected(e) => write!(f, "{e}"),
        }
    }
}

/// Longest FFmpeg diagnostic we will put in a log line.
const PROBE_STDERR_CAP: usize = 256;

/// Flatten FFmpeg's stderr to one bounded line.
///
/// This ends up in a log file on the user's disk, and FFmpeg is happy to emit
/// dozens of lines for one rejected encoder. Truncation counts `char`s rather
/// than bytes so a multi-byte sequence is never split.
fn summarize_stderr(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let flat = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    if flat.chars().count() <= PROBE_STDERR_CAP {
        return flat;
    }
    flat.chars()
        .take(PROBE_STDERR_CAP)
        .chain(std::iter::once('…'))
        .collect()
}

/// Encode 2 synthetic frames to the null muxer. Cheap, and exercises the real
/// encoder init path (driver present, session available).
fn probe(ffmpeg: &Path, choice: &EncoderChoice) -> Result<(), ProbeFailure> {
    let mut cmd = proc::command(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin"])
        .args(choice.pre_input_args)
        .args(["-f", "lavfi", "-i", "color=black:s=256x144:r=30:d=0.1"])
        .args(["-c:v", choice.name])
        .args(choice.output_args(None))
        .args(choice.tuning_args)
        .args(["-frames:v", "2", "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Piped, not null: the rejection reason is the whole point.
        .stderr(Stdio::piped());

    let output = cmd
        .output()
        .map_err(|e| ProbeFailure::FfmpegUnavailable(e.to_string()))?;
    if output.status.success() {
        return Ok(());
    }

    let detail = summarize_stderr(&output.stderr);
    Err(ProbeFailure::Rejected(if detail.is_empty() {
        format!("exited {}", output.status)
    } else {
        detail
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_list_ends_in_software_fallback() {
        let all = candidates();
        assert_eq!(all.last().unwrap().name, "libx264");
    }

    #[test]
    fn selection_falls_back_to_software_when_all_probes_fail() {
        let choice = select(Path::new("/nonexistent/ffmpeg-for-test"));
        assert_eq!(choice.name, "libx264");
    }

    #[test]
    fn probe_reports_a_spawn_failure_when_ffmpeg_is_missing() {
        let err = probe(Path::new("/nonexistent/ffmpeg-for-test"), &SOFTWARE_FALLBACK)
            .expect_err("a missing ffmpeg must not probe successfully");
        assert!(
            matches!(err, ProbeFailure::FfmpegUnavailable(_)),
            "a missing binary is an install problem, not an encoder rejection: {err:?}"
        );
    }

    #[test]
    fn stderr_summary_is_one_bounded_line() {
        let noisy = "a rejection reason\n\nand another line\n".repeat(200);
        let summary = summarize_stderr(noisy.as_bytes());
        assert!(!summary.contains('\n'), "must collapse to one line");
        assert!(
            summary.chars().count() <= PROBE_STDERR_CAP + 1,
            "must stay bounded, got {} chars",
            summary.chars().count()
        );
    }

    #[test]
    fn stderr_summary_does_not_split_multibyte_characters() {
        // Truncation counts chars, so a long run of 3-byte characters must come
        // back as valid UTF-8 rather than a replacement-char smear.
        let wide = "日".repeat(PROBE_STDERR_CAP * 2);
        let summary = summarize_stderr(wide.as_bytes());
        assert!(!summary.contains('\u{FFFD}'), "must not split a character");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_does_not_offer_media_foundation() {
        assert!(
            !candidates().iter().any(|c| c.name == "h264_mf"),
            "h264_mf displaces the faster, better libx264 fallback"
        );
    }
}

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
            EncoderChoice {
                name: "h264_mf",
                pre_input_args: &[],
                pix_fmt: Some("nv12"),
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
    PICK.get_or_init(|| {
        let all = candidates();
        for choice in all {
            if probe(ffmpeg, choice) {
                tracing::info!(encoder = choice.name, "selected H.264 encoder");
                return choice;
            }
            tracing::debug!(encoder = choice.name, "H.264 encoder probe failed");
        }
        // Every hardware probe failed — software encode is the safe last resort.
        let fallback = all.last().unwrap_or(&SOFTWARE_FALLBACK);
        tracing::warn!(
            encoder = fallback.name,
            "all encoder probes failed; falling back to software encoder"
        );
        fallback
    })
}

/// Encode 2 synthetic frames to the null muxer. Cheap, and exercises the real
/// encoder init path (driver present, session available).
fn probe(ffmpeg: &Path, choice: &EncoderChoice) -> bool {
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
        .stderr(Stdio::null());
    cmd.status().map(|s| s.success()).unwrap_or(false)
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
    fn pick_falls_back_to_software_when_all_probes_fail() {
        let choice = pick(Path::new("/nonexistent/ffmpeg-for-test"));
        assert_eq!(choice.name, "libx264");
    }
}

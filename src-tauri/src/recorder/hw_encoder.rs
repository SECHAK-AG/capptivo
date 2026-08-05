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

// --- Encoder tuning -------------------------------------------------------
//
// Every hardware encoder used to run bare, which meant FFmpeg's defaults: for
// NVENC that is the `p4` preset with multipass and lookahead, tuned for offline
// transcoding where quality-per-bit is the goal. Capptivo encodes screen
// recordings at 8–16 Mbps, where the bitrate is generous enough that the slow
// presets buy nothing visible and cost several times the encode wall time.
//
// These are throughput presets. They cannot make a *wrong* picture — they change
// how hard the encoder searches, not what it is asked to encode — so the risk
// here is an argument a driver rejects, not a quality regression. `select()`
// handles rejection by retrying the same encoder untuned, so an unsupported flag
// costs the tuning and never the hardware encoder.

/// NVENC: fastest preset, low-latency tune, single pass.
///
/// `p1` is the speed end of NVENC's preset ladder. `-tune ll` disables B-frames
/// and the lookahead buffer; `-multipass disabled` and `-rc-lookahead 0` say so
/// explicitly rather than trusting a driver default. `-surfaces 32` gives the
/// encoder a deeper input pool so it does not stall waiting on our pipe. This is
/// the set Recordly ships for the same rawvideo-over-pipe pipeline.
#[cfg(any(target_os = "windows", target_os = "linux"))]
const NVENC_TUNING: &[&str] = &[
    "-preset",
    "p1",
    "-tune",
    "ll",
    "-rc",
    "vbr",
    "-multipass",
    "disabled",
    "-rc-lookahead",
    "0",
    "-surfaces",
    "32",
];

/// QSV takes the same preset vocabulary as x264.
#[cfg(target_os = "windows")]
const QSV_TUNING: &[&str] = &["-preset", "veryfast"];

/// AMF spells it `-quality`, not `-preset`; `speed` is its fastest tier.
#[cfg(target_os = "windows")]
const AMF_TUNING: &[&str] = &["-quality", "speed"];

/// VideoToolbox is left bare, deliberately.
///
/// `-realtime true -prio_speed true` are accepted by the bundled
/// `capptivo-ffmpeg-aarch64-apple-darwin` and measurably do nothing: 600 frames
/// of 1080p60 encoded in 2.60s tuned vs 2.61s untuned, with byte-identical
/// output. Apple Silicon's media engine is already saturated at ~230 fps for
/// 1080p, so there is no search effort left to skip. Adding flags that change
/// neither speed nor output would just be noise to maintain.
#[cfg(target_os = "macos")]
const VIDEOTOOLBOX_TUNING: &[&str] = &[];

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
                tuning_args: VIDEOTOOLBOX_TUNING,
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
                tuning_args: NVENC_TUNING,
            },
            EncoderChoice {
                name: "h264_qsv",
                pre_input_args: &[],
                pix_fmt: Some("nv12"),
                upload_filter: None,
                tuning_args: QSV_TUNING,
            },
            EncoderChoice {
                name: "h264_amf",
                pre_input_args: &[],
                pix_fmt: Some("yuv420p"),
                upload_filter: None,
                tuning_args: AMF_TUNING,
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
                tuning_args: NVENC_TUNING,
            },
            SOFTWARE_FALLBACK,
        ]
    }
}

/// The probed encoder for this machine. First call runs the probes; later calls
/// return the cached pick.
pub fn pick(ffmpeg: &Path) -> &'static EncoderChoice {
    static PICK: OnceLock<EncoderChoice> = OnceLock::new();
    PICK.get_or_init(|| select(ffmpeg))
}

/// The probe loop behind [`pick`], without the cache. Split out so the fallback
/// behaviour is testable — asserting on `pick` makes the result depend on
/// whichever test happened to warm the `OnceLock` first.
fn select(ffmpeg: &Path) -> EncoderChoice {
    let all = candidates();
    for choice in all {
        match probe(ffmpeg, choice) {
            Ok(()) => {
                tracing::info!(encoder = choice.name, "selected H.264 encoder");
                return *choice;
            }
            Err(failure) => {
                // A tuned probe can fail for two very different reasons: the
                // encoder is absent, or it is present and dislikes one of our
                // flags. Only the first justifies moving on. Retrying untuned
                // keeps a working NVENC on the machine instead of demoting it to
                // libx264 over a preset name that changed between FFmpeg builds
                // — the exact silent downgrade that makes an export slow with no
                // trace of why.
                if !choice.tuning_args.is_empty() {
                    let untuned = EncoderChoice {
                        tuning_args: &[],
                        ..*choice
                    };
                    if probe(ffmpeg, &untuned).is_ok() {
                        tracing::warn!(
                            encoder = choice.name,
                            reason = %failure,
                            "H.264 encoder rejected its tuning; using it untuned"
                        );
                        return untuned;
                    }
                }
                // INFO, not DEBUG: "why is my export slow on an RTX card" is only
                // answerable from a shipped log if the rejections are in it.
                tracing::info!(
                    encoder = choice.name,
                    reason = %failure,
                    "H.264 encoder unavailable"
                );
            }
        }
    }
    // Every hardware probe failed — software encode is the safe last resort.
    let fallback = all.last().copied().unwrap_or(SOFTWARE_FALLBACK);
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

    let detail = proc::summarize_stderr(&output.stderr);
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
    fn every_candidate_is_tuned_for_throughput() {
        // Bare hardware encoders run FFmpeg's offline-transcode defaults, which
        // cost several times the encode time for quality nobody can see at the
        // bitrates Capptivo uses. Two deliberate exceptions: VAAPI's knobs are
        // driver-specific and unverifiable from here, and VideoToolbox measured
        // as a no-op (see VIDEOTOOLBOX_TUNING).
        const UNTUNED_BY_DESIGN: &[&str] = &["h264_vaapi", "h264_videotoolbox"];
        for choice in candidates() {
            if UNTUNED_BY_DESIGN.contains(&choice.name) {
                continue;
            }
            assert!(
                !choice.tuning_args.is_empty(),
                "{} ships untuned; it will use FFmpeg's slow defaults",
                choice.name
            );
        }
    }

    #[test]
    fn tuning_args_are_flag_value_pairs() {
        // A dangling flag shifts every later argument by one and FFmpeg rejects
        // the whole command, which `select` would read as "encoder unavailable".
        for choice in candidates() {
            assert_eq!(
                choice.tuning_args.len() % 2,
                0,
                "{} has an unpaired tuning argument: {:?}",
                choice.name,
                choice.tuning_args
            );
            for flag in choice.tuning_args.iter().step_by(2) {
                assert!(
                    flag.starts_with('-'),
                    "{}: expected a flag, got {flag:?}",
                    choice.name
                );
            }
        }
    }

    #[test]
    fn gop_is_left_to_the_pipeline_not_set_twice() {
        // `-g` belongs to whoever builds the command (export/recorder/proxy).
        // Setting it here too would put two conflicting values on one line.
        for choice in candidates() {
            assert!(
                !choice.tuning_args.contains(&"-g"),
                "{} sets -g in tuning_args; that belongs to the caller",
                choice.name
            );
        }
    }

    #[test]
    fn a_rejected_tuning_does_not_cost_the_encoder() {
        // The whole safety property of `select`: an argument a driver dislikes
        // must strip the tuning, never demote the machine to software encode.
        let tuned = EncoderChoice {
            name: "libx264",
            pre_input_args: &[],
            pix_fmt: Some("yuv420p"),
            upload_filter: None,
            tuning_args: &["-preset", "definitely-not-a-preset"],
        };
        let ffmpeg = crate::recorder::encoder::ffmpeg_path();
        if probe(&ffmpeg, &tuned).is_ok() {
            // No usable ffmpeg on this machine (or it accepted nonsense) — the
            // assertion below would be meaningless, so skip rather than lie.
            return;
        }
        let untuned = EncoderChoice {
            tuning_args: &[],
            ..tuned
        };
        assert!(
            probe(&ffmpeg, &untuned).is_ok(),
            "libx264 must still probe cleanly once the bad tuning is dropped"
        );
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

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_does_not_offer_media_foundation() {
        assert!(
            !candidates().iter().any(|c| c.name == "h264_mf"),
            "h264_mf displaces the faster, better libx264 fallback"
        );
    }
}

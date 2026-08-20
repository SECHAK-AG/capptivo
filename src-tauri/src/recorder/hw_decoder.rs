//! GPU decode + GPU scale for the background transcodes.
//!
//! [`hw_encoder`](crate::recorder::hw_encoder) moved *encoding* onto the GPU;
//! decoding stayed on the CPU, so a proxy transcode still walked every
//! macroblock of a 4K recording through libavcodec and then scaled it with
//! swscale. On a workstation that is invisible. On the 4-core laptops that
//! actually file "the editor freezes when I open a recording", it is the whole
//! cost of the job — and it is made worse by
//! [`proc::encode_thread_cap`](crate::proc::encode_thread_cap), which
//! deliberately hands those machines only `cores - 2` threads to keep the
//! desktop responsive.
//!
//! Measured on a 2-minute 3840x2160 H.264 recording, proxied to 1280-long-edge,
//! with FFmpeg limited to 2 threads (what `encode_thread_cap` gives a 4-core
//! machine):
//!
//! | pipeline                                  | wall time |
//! | ----------------------------------------- | --------- |
//! | CPU decode → swscale → NVENC (before)     | 22.4 s    |
//! | CUDA decode → `scale_cuda` → NVENC        |  6.3 s    |
//! | CUDA decode → swscale → NVENC             | 15.8 s    |
//!
//! Two things that table decides:
//!
//! 1. **Zero-copy or nothing.** Hardware decode whose frames are immediately
//!    downloaded to system memory for swscale recovers less than half the win —
//!    scaling 4K on 2 threads is expensive on its own. Every plan here keeps the
//!    frame on the GPU from decode through scale into the encoder, which is why
//!    each one pins `-hwaccel_output_format`.
//! 2. **The GPU path is core-count independent.** The same zero-copy pipeline
//!    measured 6.2 s with 18 threads and 6.3 s with 2 — the CPU is no longer
//!    in the loop. The slower the machine, the larger the win.
//!
//! A plan is only ever built for a decoder that shares a device with the
//! already-picked encoder, because a cross-vendor pair (say QSV decode into
//! NVENC) has to round-trip through system memory and is the thing the table
//! above rules out.
//!
//! Unlike `hw_encoder`, nothing here is probed. The encoder probe exists because
//! the recorder streams into a live FFmpeg and cannot start over when the
//! encoder turns out to be missing halfway through a take. A proxy transcode is
//! a batch job over a file that is still there afterwards, so the caller simply
//! runs the GPU command and re-runs the CPU one if it fails — see
//! [`crate::project::proxy`]. That is strictly more accurate than a probe: it
//! tests the real input on the real pipeline rather than a 2-frame synthetic
//! stand-in.

use crate::recorder::hw_encoder::EncoderChoice;

/// How a plan's GPU scaler wants its target size expressed.
///
/// `scale_cuda` and `scale_vaapi` take the same `force_original_aspect_ratio` /
/// `force_divisible_by` options as swscale, so they are a textual drop-in for
/// the CPU filter and need no knowledge of the source. `vpp_qsv` and `scale_vt`
/// accept only a literal width and height, so a plan using one is available only
/// when the caller knows the source dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scaler {
    /// Filter that can fit-inside a box by itself (`scale_cuda`, `scale_vaapi`).
    AspectAware(&'static str),
    /// Filter needing a pre-computed literal size (`vpp_qsv`, `scale_vt`).
    ExactSize(&'static str),
}

/// A complete zero-copy decode→scale pipeline for one encoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodePlan {
    /// Human name for logs — the hwaccel, not the encoder.
    pub name: &'static str,
    /// Args that must appear *before* `-i` to select the hwaccel.
    pub pre_input_args: &'static [&'static str],
    scaler: Scaler,
}

impl DecodePlan {
    /// The `-vf` value that fits the frame inside a `long_edge²` box, or `None`
    /// when this plan's scaler needs source dimensions the caller does not have.
    ///
    /// `source` is the recording's true pixel size, when known.
    pub fn scale_filter(&self, long_edge: u32, source: Option<(u32, u32)>) -> Option<String> {
        match self.scaler {
            Scaler::AspectAware(filter) => Some(format!(
                "{filter}={long_edge}:{long_edge}:force_original_aspect_ratio=decrease:force_divisible_by=2"
            )),
            Scaler::ExactSize(filter) => {
                let (w, h) = fit_inside_box(source?, long_edge)?;
                Some(match filter {
                    // vpp_qsv spells its size options `w`/`h`; scale_vt uses
                    // the positional `w:h` form swscale does.
                    "vpp_qsv" => format!("vpp_qsv=w={w}:h={h}"),
                    _ => format!("{filter}={w}:{h}"),
                })
            }
        }
    }
}

/// Fit `(w, h)` inside a `long_edge²` box, preserving aspect and keeping both
/// sides even — the same result `scale=…:force_original_aspect_ratio=decrease:
/// force_divisible_by=2` produces, computed here for the scalers that cannot.
///
/// Returns `None` for a degenerate source size, which is how an unreadable
/// `meta.json` (`recording_size` yields `(0, 0)`) declines the GPU path instead
/// of building a `vpp_qsv=w=0:h=0` that FFmpeg would reject.
fn fit_inside_box(source: (u32, u32), long_edge: u32) -> Option<(u32, u32)> {
    let (sw, sh) = source;
    if sw == 0 || sh == 0 || long_edge < 2 {
        return None;
    }
    // Never upscale: a 640x480 recording keeps its own size, matching
    // `force_original_aspect_ratio=decrease`.
    let scale = f64::min(
        f64::from(long_edge) / f64::from(sw),
        f64::from(long_edge) / f64::from(sh),
    )
    .min(1.0);
    let even = |v: f64| ((v.round() as u32).max(2)) & !1;
    Some((even(f64::from(sw) * scale), even(f64::from(sh) * scale)))
}

/// The zero-copy decode plan that pairs with `encoder`, if there is one.
///
/// Pairing is by device, not by preference: the plan's frames are handed
/// straight to `encoder` without leaving the GPU, so only a decoder on the same
/// device is usable.
///
/// Two encoders deliberately get no plan:
///
/// - **`h264_amf`** — AMF consumes system-memory frames, and the D3D11 decode
///   path that would feed it needs an explicit `hwdownload`, which is the
///   round-trip that measured no better than plain CPU decode. `-hwaccel
///   d3d11va` into AMF without one fails outright.
/// - **`libx264`** — a software encoder ends the zero-copy chain by definition,
///   and once frames are back in system memory the encode dominates anyway.
pub fn plan_for(encoder: &EncoderChoice) -> Option<DecodePlan> {
    match encoder.name {
        "h264_nvenc" => Some(DecodePlan {
            name: "cuda",
            pre_input_args: &["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
            scaler: Scaler::AspectAware("scale_cuda"),
        }),
        "h264_qsv" => Some(DecodePlan {
            name: "qsv",
            pre_input_args: &["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"],
            scaler: Scaler::ExactSize("vpp_qsv"),
        }),
        // The encoder already carries `-vaapi_device`; adding it twice is an
        // error, so the plan contributes only the hwaccel selection and reuses
        // the device the encoder opened.
        "h264_vaapi" => Some(DecodePlan {
            name: "vaapi",
            pre_input_args: &["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"],
            scaler: Scaler::AspectAware("scale_vaapi"),
        }),
        "h264_videotoolbox" => Some(DecodePlan {
            name: "videotoolbox",
            pre_input_args: &[
                "-hwaccel",
                "videotoolbox",
                "-hwaccel_output_format",
                "videotoolbox_vld",
            ],
            scaler: Scaler::ExactSize("scale_vt"),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recorder::hw_encoder;

    fn encoder_named(name: &'static str) -> hw_encoder::EncoderChoice {
        hw_encoder::for_test(name)
    }

    #[test]
    fn software_encoders_get_no_plan() {
        // A GPU decode feeding a CPU encoder has to download every frame, which
        // is the round-trip this module exists to avoid.
        assert!(plan_for(&encoder_named("libx264")).is_none());
        assert!(plan_for(&encoder_named("h264_amf")).is_none());
    }

    #[test]
    fn every_plan_keeps_frames_on_the_gpu() {
        // Without `-hwaccel_output_format` FFmpeg downloads decoded frames to
        // system memory, which measured no faster than decoding there in the
        // first place. A plan that forgets it is a silent perf regression.
        for name in ["h264_nvenc", "h264_qsv", "h264_vaapi", "h264_videotoolbox"] {
            let plan = plan_for(&encoder_named(name)).expect("hardware encoder must pair");
            assert!(
                plan.pre_input_args.contains(&"-hwaccel_output_format"),
                "{name}: plan downloads frames instead of staying on the GPU"
            );
        }
    }

    #[test]
    fn vaapi_plan_does_not_restate_the_device() {
        // `-vaapi_device` belongs to the encoder choice. Two of them on one
        // command line is an FFmpeg error, and it would take the whole
        // transcode down rather than just the tuning.
        let plan = plan_for(&encoder_named("h264_vaapi")).unwrap();
        assert!(!plan.pre_input_args.contains(&"-vaapi_device"));
    }

    #[test]
    fn pre_input_args_are_flag_value_pairs() {
        for name in ["h264_nvenc", "h264_qsv", "h264_vaapi", "h264_videotoolbox"] {
            let plan = plan_for(&encoder_named(name)).unwrap();
            assert_eq!(
                plan.pre_input_args.len() % 2,
                0,
                "{name} has an unpaired hwaccel argument: {:?}",
                plan.pre_input_args
            );
        }
    }

    #[test]
    fn aspect_aware_scaler_needs_no_source_size() {
        // scale_cuda/scale_vaapi take the same fit-inside-a-box options as
        // swscale, so an unreadable meta.json must not cost those machines the
        // GPU path.
        let plan = plan_for(&encoder_named("h264_nvenc")).unwrap();
        let filter = plan.scale_filter(1280, None).expect("no source needed");
        assert_eq!(
            filter,
            "scale_cuda=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2"
        );
    }

    #[test]
    fn exact_size_scaler_declines_without_a_source_size() {
        // `recording_size` returns (0, 0) when meta.json is unreadable. Building
        // `vpp_qsv=w=0:h=0` from that would fail the transcode; declining falls
        // back to the CPU path that never needed the dimensions.
        let plan = plan_for(&encoder_named("h264_qsv")).unwrap();
        assert!(plan.scale_filter(1280, None).is_none());
        assert!(plan.scale_filter(1280, Some((0, 0))).is_none());
    }

    #[test]
    fn exact_size_scaler_matches_the_swscale_result() {
        let plan = plan_for(&encoder_named("h264_qsv")).unwrap();
        // 3840x2160 into a 1280 box → 1280x720.
        assert_eq!(
            plan.scale_filter(1280, Some((3840, 2160))).unwrap(),
            "vpp_qsv=w=1280:h=720"
        );
        // Portrait: the long edge is the height.
        assert_eq!(
            plan.scale_filter(1280, Some((1080, 1920))).unwrap(),
            "vpp_qsv=w=720:h=1280"
        );
    }

    #[test]
    fn fit_never_upscales() {
        // `force_original_aspect_ratio=decrease` leaves a small recording alone;
        // blowing a 640x480 capture up to 1280x960 would make the proxy larger
        // to decode than the original it stands in for.
        assert_eq!(fit_inside_box((640, 480), 1280), Some((640, 480)));
    }

    #[test]
    fn fit_keeps_both_sides_even() {
        // H.264 chroma subsampling needs even dimensions; an odd side is
        // rejected by the encoder, not silently rounded.
        for source in [(1919, 1079), (1001, 999), (3839, 2161)] {
            let (w, h) = fit_inside_box(source, 1280).unwrap();
            assert_eq!(w % 2, 0, "{source:?} produced odd width {w}");
            assert_eq!(h % 2, 0, "{source:?} produced odd height {h}");
        }
    }

    #[test]
    fn fit_rejects_a_degenerate_source() {
        assert!(fit_inside_box((0, 1080), 1280).is_none());
        assert!(fit_inside_box((1920, 0), 1280).is_none());
    }
}

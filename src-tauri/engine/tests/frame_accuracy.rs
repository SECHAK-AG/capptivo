//! End-to-end frame selection: every exported frame must show exactly the
//! source frame the editor's frame clock picks, across trims and seeks.
//!
//! The source is synthetic: frame `n` is a flat grey whose luma encodes `n`,
//! so a frame's identity survives decode → composite → NV12 unchanged (grey is
//! preserved exactly by the BT.601 → RGB → BT.709 round trip).
//!
//! Needs the bundled FFmpeg sidecars and a GPU; skips (with a note) when
//! either is missing, e.g. on CI runners without graphics.

use std::path::{Path, PathBuf};
use std::process::Command;

use capptivo_engine::document::{RenderDocument, TrimSegment};
use capptivo_engine::encode::EncoderSpec;
use capptivo_engine::export::{render_stills, ExportRequest};
use capptivo_engine::media::probe;
use capptivo_engine::timeline::segments::plan_frame_times;

const SOURCE_FPS: u32 = 30;
const SIZE: u32 = 64;
/// Luma of frame `n` is `LUMA_BASE + (n · LUMA_STEP) % LUMA_SPAN`. Adjacent
/// frames differ by 3 levels, so the ±1 rounding tolerance below can never
/// mistake one frame for its neighbour.
const LUMA_BASE: u32 = 20;
const LUMA_STEP: u32 = 3;
const LUMA_SPAN: u32 = 210;

fn sidecar(name: &str) -> Option<PathBuf> {
    let triple = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc.exe"
    } else {
        "x86_64-unknown-linux-gnu"
    };
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../binaries/capptivo-{name}-{triple}"));
    path.is_file().then_some(path)
}

/// 20 s at 30 fps, keyframe every second, lossless.
fn make_source(ffmpeg: &Path, out: &Path) {
    let filter = format!(
        "color=c=black:s={SIZE}x{SIZE}:r={SOURCE_FPS}:d=20,format=yuv420p,geq=lum='{LUMA_BASE}+mod(N*{LUMA_STEP}\\,{LUMA_SPAN})':cb=128:cr=128"
    );
    let status = Command::new(ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", &filter])
        .args([
            "-c:v", "libx264", "-qp", "0", "-g", "30", "-bf", "0", "-pix_fmt", "yuv420p",
        ])
        .arg(out)
        .status()
        .expect("run ffmpeg");
    assert!(status.success(), "could not synthesize the source video");
}

fn document(segments: Vec<TrimSegment>) -> RenderDocument {
    let mut doc: RenderDocument = serde_json::from_value(serde_json::json!({
        "sourceVideoSize": {"width": SIZE, "height": SIZE},
        "sourceAspect": 1.0,
        "aspectRatioPresetId": "recording",
        "duration": 20.0,
        "look": {"cornerRadius": 0, "devicePadding": 0},
        "cursorSettings": {"showCursor": false},
    }))
    .unwrap();
    doc.segments = segments;
    doc
}

fn seg(start: f64, end: f64) -> TrimSegment {
    TrimSegment {
        id: String::new(),
        start,
        end,
    }
}

#[test]
fn every_frame_shows_the_planned_source_frame() {
    let (Some(ffmpeg), Some(ffprobe)) = (sidecar("ffmpeg"), sidecar("ffprobe")) else {
        eprintln!("skipping: FFmpeg sidecars not fetched (pnpm fetch:ffmpeg)");
        return;
    };
    if capptivo_engine::gpu::GpuContext::new().is_err() {
        eprintln!("skipping: no GPU adapter");
        return;
    }
    let dir = std::env::temp_dir().join(format!("capptivo-frame-accuracy-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("source.mp4");
    make_source(&ffmpeg, &source);
    let info = probe(&ffprobe, &source).unwrap();
    assert_eq!(info.frame_times.len(), 600);

    // Three kept ranges: a plain run, a short hop forward (decoded through)
    // and a jump far past the next keyframes (decoder restarts at a seek).
    let segments = vec![seg(0.0, 2.0), seg(2.5, 3.2), seg(11.0, 12.4)];
    for out_fps in [60u32, 30, 24] {
        let doc = document(segments.clone());
        let times = plan_frame_times(&doc.kept_segments(), f64::from(out_fps));
        let request = ExportRequest {
            document: doc,
            screen: source.clone(),
            camera: None,
            background: None,
            ffprobe: ffprobe.clone(),
            encoder: EncoderSpec {
                ffmpeg: ffmpeg.clone(),
                pre_input_args: Vec::new(),
                video_args: Vec::new(),
            },
            output: PathBuf::new(),
            width: SIZE,
            height: SIZE,
            fps: out_fps,
            audio: None,
        };
        let frames = render_stills(&request, &times).unwrap();
        assert_eq!(frames.len(), times.len());
        for (i, (frame, &t)) in frames.iter().zip(&times).enumerate() {
            let expected_index = info.frame_index_at(t) as u32;
            let expected_luma = LUMA_BASE + (expected_index * LUMA_STEP) % LUMA_SPAN;
            let centre = frame[(SIZE / 2 * SIZE + SIZE / 2) as usize];
            assert!(
                (i32::from(centre) - expected_luma as i32).abs() <= 1,
                "{out_fps} fps, output frame {i} at t={t:.4}: luma {centre}, want source frame {expected_index} (luma {expected_luma})"
            );
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

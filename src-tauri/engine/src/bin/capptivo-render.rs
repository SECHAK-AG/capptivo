//! Headless driver for the render engine: benchmark exports and inspect frames
//! without launching the app.
//!
//! ```text
//! capptivo-render export <project-dir> <out.mp4> [--fps 60] [--size 1920x1072]
//!                        [--seconds N] [--encoder h264_videotoolbox] [--bitrate BPS]
//! capptivo-render still  <project-dir> <seconds> <out.png> [--size WxH]
//! ```
//!
//! Testing aids: `--background <image>` replaces the background,
//! `--patch '<json>'` deep-merges into the render document and
//! `--audio <m4a>` muxes a prepared audio track.
//!
//! FFmpeg defaults to the bundled sidecar (`src-tauri/binaries`); override with
//! `CAPPTIVO_FFMPEG` / `CAPPTIVO_FFPROBE`.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use capptivo_engine::document::{Size, TrimSegment};
use capptivo_engine::encode::EncoderSpec;
use capptivo_engine::export::{export, render_stills, ExportRequest};
use capptivo_engine::layout::{export_dimensions_for_video, resolve_stage_size};
use capptivo_engine::media::probe;
use capptivo_engine::project::load_project;

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("capptivo-render: {e}");
            ExitCode::FAILURE
        }
    }
}

struct Options {
    positional: Vec<String>,
    fps: u32,
    size: Option<(u32, u32)>,
    seconds: Option<f64>,
    encoder: Option<String>,
    bitrate: Option<u64>,
    background: Option<PathBuf>,
    patch: Option<serde_json::Value>,
    audio: Option<PathBuf>,
}

fn parse(args: Vec<String>) -> Result<Options, String> {
    let mut o = Options {
        positional: Vec::new(),
        fps: 60,
        size: None,
        seconds: None,
        encoder: None,
        bitrate: None,
        background: None,
        patch: None,
        audio: None,
    };
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--fps" => o.fps = value("--fps")?.parse().map_err(|e| format!("--fps: {e}"))?,
            "--size" => {
                let v = value("--size")?;
                let (w, h) = v.split_once('x').ok_or("--size is WxH")?;
                o.size = Some((
                    w.parse().map_err(|e| format!("--size: {e}"))?,
                    h.parse().map_err(|e| format!("--size: {e}"))?,
                ));
            }
            "--seconds" => {
                o.seconds = Some(
                    value("--seconds")?
                        .parse()
                        .map_err(|e| format!("--seconds: {e}"))?,
                )
            }
            "--encoder" => o.encoder = Some(value("--encoder")?),
            "--bitrate" => {
                o.bitrate = Some(
                    value("--bitrate")?
                        .parse()
                        .map_err(|e| format!("--bitrate: {e}"))?,
                )
            }
            "--background" => o.background = Some(PathBuf::from(value("--background")?)),
            "--audio" => o.audio = Some(PathBuf::from(value("--audio")?)),
            "--patch" => {
                o.patch = Some(
                    serde_json::from_str(&value("--patch")?)
                        .map_err(|e| format!("--patch: {e}"))?,
                )
            }
            _ if arg.starts_with("--") => return Err(format!("unknown option {arg}")),
            _ => o.positional.push(arg),
        }
    }
    Ok(o)
}

fn sidecar(env: &str, name: &str) -> PathBuf {
    if let Some(path) = std::env::var_os(env) {
        return path.into();
    }
    let triple = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc.exe"
    } else {
        "x86_64-unknown-linux-gnu"
    };
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../binaries/capptivo-{name}-{triple}"))
}

fn public_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public")
}

fn default_encoder() -> &'static str {
    if cfg!(target_os = "macos") {
        "h264_videotoolbox"
    } else {
        "libx264"
    }
}

/// The editor's "balanced" bitrate for `width`×`height` at `fps`
/// (`scaledVideoBitrate` in `exportSettings.ts`).
fn balanced_bitrate(width: u32, height: u32, fps: u32) -> u64 {
    let pixel_scale = f64::from(width) * f64::from(height) / (1920.0 * 1080.0);
    let fps_scale = (f64::from(fps) / 30.0).max(1.0).sqrt();
    (8_000_000.0 * pixel_scale * fps_scale)
        .round()
        .clamp(500_000.0, 50_000_000.0) as u64
}

fn request(o: &Options, dir: &Path, output: PathBuf) -> Result<ExportRequest, String> {
    let ffprobe = sidecar("CAPPTIVO_FFPROBE", "ffprobe");
    let ffmpeg = sidecar("CAPPTIVO_FFMPEG", "ffmpeg");
    let screen_path = dir.join("screen.mp4");
    let info = probe(&ffprobe, &screen_path).map_err(|e| e.to_string())?;
    let size = Size {
        width: f64::from(info.width),
        height: f64::from(info.height),
    };
    let mut loaded = load_project(dir, size, info.duration).map_err(|e| e.to_string())?;
    if let Some(patch) = &o.patch {
        let mut doc = serde_json::to_value(&loaded.document).map_err(|e| e.to_string())?;
        merge(&mut doc, patch);
        loaded.document = serde_json::from_value(doc).map_err(|e| format!("--patch: {e}"))?;
    }
    if let Some(limit) = o.seconds {
        // Keep the first `limit` seconds of the edited timeline.
        let mut left = limit;
        let mut kept: Vec<TrimSegment> = Vec::new();
        for mut seg in loaded.document.kept_segments() {
            if left <= 0.0 {
                break;
            }
            seg.end = seg.end.min(seg.start + left);
            left -= seg.end - seg.start;
            kept.push(seg);
        }
        loaded.document.segments = kept;
    }
    let (width, height) = match o.size {
        Some(size) => size,
        None => {
            let stage = resolve_stage_size(loaded.document.aspect_ratio_preset_id, Some(size));
            let out = export_dimensions_for_video(stage.width, stage.height, 1920.0);
            (out.width as u32, out.height as u32)
        }
    };
    let background = match (&o.background, &loaded.background_preset) {
        (Some(path), _) => {
            Some(std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?)
        }
        (None, Some(file)) => Some(
            std::fs::read(public_dir().join("background-images").join(file))
                .map_err(|e| format!("background {file}: {e}"))?,
        ),
        (None, None) => None,
    };
    let encoder_name = o
        .encoder
        .clone()
        .unwrap_or_else(|| default_encoder().to_string());
    let bitrate = o
        .bitrate
        .unwrap_or_else(|| balanced_bitrate(width, height, o.fps));
    Ok(ExportRequest {
        document: loaded.document,
        screen: loaded.screen,
        camera: loaded.camera,
        background,
        ffprobe,
        encoder: EncoderSpec {
            ffmpeg,
            pre_input_args: Vec::new(),
            video_args: vec![
                "-c:v".into(),
                encoder_name,
                "-b:v".into(),
                bitrate.to_string(),
            ],
        },
        output,
        width,
        height,
        fps: o.fps,
        audio: o.audio.clone(),
    })
}

fn run(args: Vec<String>) -> Result<(), String> {
    let o = parse(args)?;
    match o.positional.first().map(String::as_str) {
        Some("export") if o.positional.len() == 3 => {
            let dir = PathBuf::from(&o.positional[1]);
            let req = request(&o, &dir, PathBuf::from(&o.positional[2]))?;
            eprintln!(
                "exporting {}x{} @ {} fps → {}",
                req.width,
                req.height,
                req.fps,
                req.output.display()
            );
            let started = Instant::now();
            let mut last = Instant::now();
            let stats = export(
                &req,
                |p| {
                    if last.elapsed().as_secs_f64() > 1.0 {
                        last = Instant::now();
                        eprintln!("  {}/{} frames", p.frames_done, p.frames_total);
                    }
                },
                Arc::new(AtomicBool::new(false)),
            )
            .map_err(|e| e.to_string())?;
            eprintln!("{stats}");
            eprintln!("total {:.2}s", started.elapsed().as_secs_f64());
            Ok(())
        }
        Some("still") if o.positional.len() == 4 => {
            let dir = PathBuf::from(&o.positional[1]);
            let t: f64 = o.positional[2].parse().map_err(|e| format!("time: {e}"))?;
            let req = request(&o, &dir, PathBuf::new())?;
            let frames = render_stills(&req, &[t]).map_err(|e| e.to_string())?;
            let frame = frames.first().ok_or("no frame rendered")?;
            nv12_to_png(frame, req.width, req.height, Path::new(&o.positional[3]))
        }
        _ => Err("usage: capptivo-render export <project> <out.mp4> [options] | still <project> <seconds> <out.png>".into()),
    }
}

/// Deep-merge `patch` into `doc` (objects merge, everything else replaces).
fn merge(doc: &mut serde_json::Value, patch: &serde_json::Value) {
    match (doc, patch) {
        (serde_json::Value::Object(d), serde_json::Value::Object(p)) => {
            for (k, v) in p {
                merge(d.entry(k.clone()).or_insert(serde_json::Value::Null), v);
            }
        }
        (d, p) => *d = p.clone(),
    }
}

/// BT.709 limited NV12 → sRGB PNG.
fn nv12_to_png(nv12: &[u8], width: u32, height: u32, path: &Path) -> Result<(), String> {
    let (w, h) = (width as usize, height as usize);
    let mut rgb = image::RgbImage::new(width, height);
    for y in 0..h {
        for x in 0..w {
            let luma = (f64::from(nv12[y * w + x]) - 16.0) * (255.0 / 219.0);
            let uv = w * h + (y / 2) * w + (x / 2) * 2;
            let cb = (f64::from(nv12[uv]) - 128.0) * (255.0 / 224.0);
            let cr = (f64::from(nv12[uv + 1]) - 128.0) * (255.0 / 224.0);
            let (kr, kb) = (0.2126, 0.0722);
            let r = luma + 2.0 * (1.0 - kr) * cr;
            let b = luma + 2.0 * (1.0 - kb) * cb;
            let g = (luma - kr * r - kb * b) / (1.0 - kr - kb);
            let px = |v: f64| v.round().clamp(0.0, 255.0) as u8;
            rgb.put_pixel(x as u32, y as u32, image::Rgb([px(r), px(g), px(b)]));
        }
    }
    rgb.save(path)
        .map_err(|e| format!("{}: {e}", path.display()))
}

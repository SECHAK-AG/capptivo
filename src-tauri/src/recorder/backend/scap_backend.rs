//! ScreenCaptureKit capture via the `scap` crate. **This is the only file that
//! drives video through `scap`** (TAURI_DESKTOP_MIGRATION.md §15). System audio
//! is a companion SCStream in [`super::system_audio`] — scap 0.0.8 has no
//! `captures_audio`.
//!
//! Threading: the `scap::Capturer` is not `Send`, so it is *built and driven
//! entirely inside the producer thread*. `start()` hands the thread a plain
//! `source_id` string and receives the resolved output size back over a
//! rendezvous channel before returning the [`CaptureHandle`].

use super::system_audio::SystemAudioTap;
use super::picker_sources;
use super::source_preview;
use super::{CaptureBackend, CaptureHandle, RawFrame, CAPTURE_CHANNEL_CAP};
use crate::error::{AppError, AppResult};
use crate::recorder::types::{CaptureSource, CaptureSourceKind, RecorderConfig};
use core_graphics::display::CGDisplay;
use scap::capturer::{Area, Capturer, Options, Point, Size};
use scap::frame::{Frame, FrameType};
use scap::Target;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub struct ScapBackend;

impl ScapBackend {
    pub fn new() -> Self {
        Self
    }
}

impl CaptureBackend for ScapBackend {
    fn is_supported(&self) -> bool {
        scap::is_supported()
    }

    fn has_permission(&self) -> bool {
        scap::has_permission()
    }

    fn request_permission(&self) -> bool {
        scap::request_permission()
    }

    fn list_sources(&self) -> AppResult<Vec<CaptureSource>> {
        if !scap::is_supported() {
            return Err(AppError::Unsupported);
        }
        if !scap::has_permission() {
            return Err(AppError::PermissionDenied);
        }

        let main_id = CGDisplay::main().id;
        let mut sources = Vec::new();

        for target in scap::get_all_targets() {
            if let Target::Display(display) = target {
                let cg = CGDisplay::new(display.id);
                let bounds = cg.bounds();
                let preview = source_preview::display_thumbnail(display.id);
                sources.push(CaptureSource {
                    id: format!("display:{}", display.id),
                    kind: CaptureSourceKind::Display,
                    title: if display.title.is_empty() {
                        format!("Display {}", display.id)
                    } else {
                        display.title.clone()
                    },
                    width: bounds.size.width as u32,
                    height: bounds.size.height as u32,
                    is_primary: display.id == main_id,
                    thumbnail: preview.map(|p| p.png_base64),
                });
            }
        }

        for window in picker_sources::recordable_windows()? {
            let preview = source_preview::window_thumbnail(window.id);
            sources.push(CaptureSource {
                id: format!("window:{}", window.id),
                kind: CaptureSourceKind::Window,
                title: window.title,
                width: preview.as_ref().map(|p| p.width).unwrap_or(0),
                height: preview.as_ref().map(|p| p.height).unwrap_or(0),
                is_primary: false,
                thumbnail: preview.map(|p| p.png_base64),
            });
        }

        Ok(sources)
    }

    fn start(&self, config: &RecorderConfig) -> AppResult<CaptureHandle> {
        if !scap::is_supported() {
            return Err(AppError::Unsupported);
        }
        if !scap::has_permission() {
            return Err(AppError::PermissionDenied);
        }

        let fps = config.fps.clamp(1, 120);
        let source_id = config.source_id.clone();
        let crop = config.crop;

        let (tx, rx) = crossbeam_channel::bounded::<RawFrame>(CAPTURE_CHANNEL_CAP);
        let (meta_tx, meta_rx) =
            crossbeam_channel::bounded::<AppResult<([u32; 2], Instant)>>(1);
        let stop_flag = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));

        let producer_stop = stop_flag.clone();
        let producer_dropped = dropped.clone();
        std::thread::Builder::new()
            .name("scap-capture".into())
            .spawn(move || {
                let target = match resolve_target(&source_id) {
                    Ok(t) => t,
                    Err(e) => {
                        let _ = meta_tx.send(Err(e));
                        return;
                    }
                };

                let crop_area = crop.map(|c| Area {
                    origin: Point { x: c.x, y: c.y },
                    size: Size {
                        width: c.width,
                        height: c.height,
                    },
                });

                let excluded_targets = overlay_exclude_targets();

                let options = Options {
                    fps,
                    // Never bake the OS cursor into frames — Capptivo redraws a
                    // customizable cursor in the editor from `cursor.json`.
                    show_cursor: false,
                    output_type: FrameType::BGRAFrame,
                    target: Some(target),
                    crop_area,
                    excluded_targets,
                    ..Default::default()
                };

                let mut capturer = match Capturer::build(options) {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = meta_tx.send(Err(AppError::Other(format!(
                            "failed to build capturer: {e}"
                        ))));
                        return;
                    }
                };
                // Anchor SCK's presentation clock to an `Instant` *before* any
                // frame can be displayed: `display_time` minus this anchor puts
                // every frame on the same time axis as the cursor sampler (the
                // handle's `epoch`). Rebasing to the first frame instead made
                // the cursor track lead the video by the whole warm-up gap.
                let epoch = Instant::now();
                let epoch_host_ns = host_clock_ns();
                capturer.start_capture();

                let [w, h] = capturer.get_output_frame_size();
                if meta_tx.send(Ok(([w, h], epoch))).is_err() {
                    capturer.stop_capture();
                    return;
                }

                while !producer_stop.load(Ordering::Relaxed) {
                    let frame = match capturer.get_next_frame() {
                        Ok(f) => f,
                        Err(_) => break,
                    };

                    let Some(raw) = to_raw_frame(frame, epoch_host_ns, epoch) else {
                        continue;
                    };

                    match tx.try_send(raw) {
                        Ok(()) => {}
                        Err(crossbeam_channel::TrySendError::Full(_)) => {
                            producer_dropped.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(crossbeam_channel::TrySendError::Disconnected(_)) => break,
                    }
                }

                capturer.stop_capture();
            })
            .map_err(|e| AppError::Other(format!("failed to spawn capture thread: {e}")))?;

        let ([width, height], epoch) = meta_rx
            .recv()
            .map_err(|_| AppError::Other("capture thread exited before start".into()))??;

        // Optional system-audio companion stream (same source id).
        let audio_tap = if config.capture_system_audio {
            match SystemAudioTap::start(&config.source_id) {
                Ok(tap) => Some(tap),
                Err(e) => {
                    tracing::warn!(%e, "system audio unavailable; continuing video-only");
                    None
                }
            }
        } else {
            None
        };

        let stop = {
            let stop_flag = stop_flag.clone();
            move || stop_flag.store(true, Ordering::Relaxed)
        };
        let mut handle = CaptureHandle::new(width, height, fps, rx, dropped, stop);
        handle.epoch = epoch;

        if let Some(tap) = audio_tap {
            let rx = tap.rx.clone();
            handle.attach_audio(rx, move || drop(tap));
        }

        // Cursor samples are normalized against this rect (global points, the
        // space `CGEvent::location` reports in) — it must describe exactly the
        // area the frames show, or the replayed cursor lands off its pixels.
        match config.source_id.split_once(':') {
            Some(("display", id_str)) => {
                if let Ok(id) = id_str.parse::<u32>() {
                    let cg = CGDisplay::new(id);
                    let bounds = cg.bounds();
                    let (rect, scale_base) = if let Some(crop) = config.crop {
                        (
                            crate::cursor::CaptureRect {
                                x: bounds.origin.x + crop.x,
                                y: bounds.origin.y + crop.y,
                                width: crop.width,
                                height: crop.height,
                            },
                            crop.width,
                        )
                    } else {
                        (
                            crate::cursor::CaptureRect {
                                x: bounds.origin.x,
                                y: bounds.origin.y,
                                width: bounds.size.width,
                                height: bounds.size.height,
                            },
                            bounds.size.width,
                        )
                    };
                    handle.capture_rect = rect;
                    if scale_base > 0.0 {
                        handle.scale_factor = width as f64 / scale_base;
                    }
                }
            }
            Some(("window", id_str)) => {
                // ponytail: the rect is sampled once at start — a window moved
                // mid-recording drifts the cursor until per-sample window
                // tracking is added.
                if let Some(rect) = id_str
                    .parse::<u32>()
                    .ok()
                    .and_then(picker_sources::window_frame)
                {
                    if rect.width > 0.0 {
                        handle.scale_factor = width as f64 / rect.width;
                    }
                    handle.capture_rect = rect;
                }
            }
            _ => {}
        }

        Ok(handle)
    }
}

fn resolve_target(source_id: &str) -> AppResult<Target> {
    let (kind, id_str) = source_id
        .split_once(':')
        .ok_or_else(|| AppError::InvalidSource(source_id.to_string()))?;
    let id: u32 = id_str
        .parse()
        .map_err(|_| AppError::InvalidSource(source_id.to_string()))?;

    for target in scap::get_all_targets() {
        match (&target, kind) {
            (Target::Display(d), "display") if d.id == id => return Ok(target),
            (Target::Window(w), "window") if w.id == id => return Ok(target),
            _ => {}
        }
    }
    Err(AppError::InvalidSource(source_id.to_string()))
}

/// Capptivo chrome that must stay visible to the user but out of `screen.mp4`.
/// Applied at capturer build time only — windows created after start (the
/// editor) are not covered; `stop_recording` must halt capture before showing
/// them.
fn overlay_exclude_targets() -> Option<Vec<Target>> {
    let excluded: Vec<Target> = scap::get_all_targets()
        .into_iter()
        .filter(|t| match t {
            Target::Window(w) => {
                let title = w.title.as_str();
                title == "Capptivo Camera"
                    || title == "Capptivo"
                    || title == "Capptivo Editor"
                    || title.starts_with("Capptivo Area")
            }
            _ => false,
        })
        .collect();
    if excluded.is_empty() {
        None
    } else {
        Some(excluded)
    }
}

/// Current host-clock time in nanoseconds. `CLOCK_UPTIME_RAW` is
/// `mach_absolute_time` in ns — the same clock CoreMedia presentation
/// timestamps (`display_time`) are expressed in, and the same clock backing
/// `std::time::Instant` on macOS. Reading it next to an `Instant::now()`
/// therefore anchors the two time axes exactly.
fn host_clock_ns() -> u64 {
    extern "C" {
        fn clock_gettime_nsec_np(clock_id: u32) -> u64;
    }
    const CLOCK_UPTIME_RAW: u32 = 8;
    unsafe { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }
}

fn to_raw_frame(frame: Frame, epoch_host_ns: u64, epoch: Instant) -> Option<RawFrame> {
    let Frame::BGRA(f) = frame else {
        return None;
    };
    let width = f.width.max(0) as u32;
    let height = f.height.max(0) as u32;
    if width == 0 || height == 0 || f.data.is_empty() {
        return None;
    }

    // Presentation time on the shared epoch axis (see `CaptureHandle::epoch`).
    let timestamp = if f.display_time > 0 {
        Duration::from_nanos(f.display_time.saturating_sub(epoch_host_ns))
    } else {
        // No PTS on this frame — receipt time is the best remaining estimate.
        epoch.elapsed()
    };

    // scap 0.0.8's BGRAFrame doesn't surface the row stride, so recover it from
    // the buffer: ScreenCaptureKit often returns rows aligned (e.g. to 64), and
    // assuming the tight `width * 4` would shear every frame on padded captures.
    let tight_row = (width as usize) * 4;
    let bytes_per_row = if height > 0 && f.data.len() % (height as usize) == 0 {
        let stride = f.data.len() / (height as usize);
        if stride >= tight_row {
            stride as u32
        } else {
            width * 4
        }
    } else {
        width * 4
    };

    Some(RawFrame {
        width,
        height,
        bytes_per_row,
        data: f.data,
        timestamp,
    })
}

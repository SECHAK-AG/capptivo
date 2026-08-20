//! Display capture via the `scap` crate; window capture via native SCK
//! (`sck_window`). **scap is only used for `display:` sources**
//! (TAURI_DESKTOP_MIGRATION.md §15). scap's `Target::Window` looks up windows
//! through `NSApp windowWithWindowNumber`, which is null for other apps and
//! aborts the process — window video uses `DesktopIndependentWindow` instead.
//! System audio is a companion SCStream in [`super::system_audio`]; microphone
//! is Core Audio via [`super::cpal_mic`].
//!
//! Threading: the `scap::Capturer` is not `Send`, so it is *built and driven
//! entirely inside the producer thread*. `start()` hands the thread a plain
//! `source_id` string and receives the resolved output size back over a
//! rendezvous channel before returning the [`CaptureHandle`].

use super::sck_window;
use super::system_audio::SystemAudioTap;
use super::picker_sources;
use super::source_preview;
use super::{CaptureBackend, CaptureHandle, RawFrame, CAPTURE_CHANNEL_CAP};
use crate::error::{AppError, AppResult};
use crate::recorder::hw_encoder;
use crate::recorder::types::{CaptureCrop, CaptureSource, CaptureSourceKind, RecorderConfig};
use crate::windows;
use core_graphics::display::CGDisplay;
use scap::capturer::{Area, Capturer, Options, Point, Resolution, Size};
use scap::frame::{Frame, FrameType};
use scap::Target;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub struct ScapBackend {
    app: AppHandle,
}

impl ScapBackend {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
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

    fn list_sources(&self, include_thumbnails: bool) -> AppResult<Vec<CaptureSource>> {
        if !scap::is_supported() {
            return Err(AppError::Unsupported);
        }
        if !scap::has_permission() {
            return Err(AppError::PermissionDenied);
        }

        let main_id = CGDisplay::main().id;
        let mut sources = Vec::new();

        for (id, title) in picker_sources::list_displays()? {
            let cg = CGDisplay::new(id);
            let bounds = cg.bounds();
            let preview = if include_thumbnails {
                source_preview::display_thumbnail(id)
            } else {
                None
            };
            sources.push(CaptureSource {
                id: format!("display:{id}"),
                kind: CaptureSourceKind::Display,
                title,
                width: bounds.size.width as u32,
                height: bounds.size.height as u32,
                is_primary: id == main_id,
                thumbnail: preview.map(|p| p.png_base64),
            });
        }

        for window in picker_sources::recordable_windows()? {
            let preview = if include_thumbnails {
                source_preview::window_thumbnail(window.id)
            } else {
                None
            };
            // Thumbnail picker: drop off-screen windows with no live preview (minimized
            // / hidden). On-screen windows stay even without a thumb; boot-time lists
            // skip this filter (`include_thumbnails: false`).
            if include_thumbnails
                && preview.is_none()
                && !picker_sources::is_in_on_screen_set(window.id)?
            {
                continue;
            }
            sources.push(CaptureSource {
                id: format!("window:{}", window.id),
                kind: CaptureSourceKind::Window,
                title: window.title,
                width: window.width,
                height: window.height,
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
        let is_window = source_id.starts_with("window:");
        // Resolve HUD/camera CGWindowIDs on this thread (needs AppHandle) before
        // the producer moves — never match by title (library used to setTitle
        // "Capptivo" and collide with the HUD, blacking fullscreen takes).
        let exclude_ids = if is_window {
            Vec::new()
        } else {
            windows::overlay_cgwindow_ids(&self.app)
        };
        // A display or area wider than the hardware encoder takes is scaled by
        // SCK on the GPU (see `hw_encoder::HW_ENCODER_EDGE`). scap only offers
        // preset output sizes, so this picks the largest one that lands inside
        // the edge; the window path sizes its own stream in `sck_window`.
        let output_resolution = if is_window {
            Resolution::Captured
        } else {
            display_output_resolution(&source_id, crop)
        };

        let (tx, rx) = crossbeam_channel::bounded::<RawFrame>(CAPTURE_CHANNEL_CAP);
        let (meta_tx, meta_rx) =
            crossbeam_channel::bounded::<AppResult<([u32; 2], Instant, u64)>>(1);
        let stop_flag = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));

        let producer_stop = stop_flag.clone();
        let producer_dropped = dropped.clone();
        let producer_source = source_id.clone();
        std::thread::Builder::new()
            .name(if is_window {
                "sck-window-capture".into()
            } else {
                "scap-capture".into()
            })
            .spawn(move || {
                if is_window {
                    let window_id = match parse_source_id(&producer_source) {
                        Ok(id) => id,
                        Err(e) => {
                            let _ = meta_tx.send(Err(e));
                            return;
                        }
                    };
                    sck_window::run_window_capture(
                        window_id,
                        fps,
                        producer_stop,
                        producer_dropped,
                        tx,
                        meta_tx,
                    );
                    return;
                }

                let target = match resolve_display_target(&producer_source) {
                    Ok(target) => target,
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

                let excluded_targets = overlay_exclude_targets(&exclude_ids);

                let options = Options {
                    fps,
                    show_cursor: false,
                    output_type: FrameType::BGRAFrame,
                    output_resolution,
                    target: Some(target),
                    crop_area,
                    excluded_targets,
                    ..Default::default()
                };

                let epoch = Instant::now();
                let epoch_host_ns = host_clock_ns();
                let (mut capturer, [w, h]) = match start_scap_capturer(options) {
                    Ok(pair) => pair,
                    Err(e) => {
                        let _ = meta_tx.send(Err(e));
                        return;
                    }
                };
                if meta_tx.send(Ok(([w, h], epoch, epoch_host_ns))).is_err() {
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

        let ([width, height], epoch, epoch_host_ns) = if is_window {
            match meta_rx.recv_timeout(sck_window::FIRST_FRAME_TIMEOUT) {
                Ok(Ok(meta)) => meta,
                Ok(Err(e)) => return Err(e),
                Err(_) => {
                    stop_flag.store(true, Ordering::Relaxed);
                    return Err(AppError::Other(
                        "window capture timed out waiting for the first frame".into(),
                    ));
                }
            }
        } else {
            meta_rx
                .recv()
                .map_err(|_| AppError::Other("capture thread exited before start".into()))??
        };

        let stop = {
            let stop_flag = stop_flag.clone();
            move || stop_flag.store(true, Ordering::Relaxed)
        };
        let mut handle = CaptureHandle::new(width, height, fps, rx, dropped, stop);
        handle.epoch = epoch;

        // System audio: SCK companion. Mic: Core Audio (cpal) — same stack as
        // Windows, so Bluetooth headsets work without SCK sample-rate lies.
        if config.capture_system_audio {
            match SystemAudioTap::start(&config.source_id, epoch_host_ns) {
                Ok(tap) => {
                    let system_rx = tap.system_rx.clone();
                    handle.attach_audio(system_rx, move || drop(tap));
                }
                Err(e) => {
                    tracing::warn!(%e, "system audio unavailable; continuing without it");
                }
            }
        }
        super::cpal_mic::attach_configured_mic(&mut handle, config);

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
                    let scale = picker_sources::display_scale_factor(id);
                    let native =
                        picker_sources::points_to_even_pixels(rect.width, rect.height, scale);
                    handle.notice = hw_encoder::scaled_capture_notice(native, (width, height));
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
                    let scale = display_scale_for_rect(&rect);
                    let native =
                        picker_sources::points_to_even_pixels(rect.width, rect.height, scale);
                    handle.notice = hw_encoder::scaled_capture_notice(native, (width, height));
                    handle.capture_rect = rect;
                }
            }
            _ => {}
        }

        Ok(handle)
    }
}

fn start_scap_capturer(options: Options) -> AppResult<(Capturer, [u32; 2])> {
    let mut capturer = Capturer::build(options)
        .map_err(|e| AppError::Other(format!("failed to build capturer: {e}")))?;
    capturer.start_capture();
    let size = capturer.get_output_frame_size();
    Ok((capturer, size))
}

/// Backing scale of the display under a window frame's centre — the scale
/// `sck_window` sized the stream with, recovered from Core Graphics so the
/// notice can name the window's native pixel size. Falls back to the main
/// display, like `sck_window` does when no display intersects the frame.
fn display_scale_for_rect(rect: &crate::cursor::CaptureRect) -> u32 {
    let cx = rect.x + rect.width / 2.0;
    let cy = rect.y + rect.height / 2.0;
    let id = CGDisplay::active_displays()
        .ok()
        .and_then(|ids| {
            ids.into_iter().find(|&id| {
                let b = CGDisplay::new(id).bounds();
                cx >= b.origin.x
                    && cx < b.origin.x + b.size.width
                    && cy >= b.origin.y
                    && cy < b.origin.y + b.size.height
            })
        })
        .unwrap_or_else(|| CGDisplay::main().id);
    picker_sources::display_scale_factor(id)
}

/// The scap output preset for a display (or area) capture: `Captured` when
/// the backing-store size fits `hw_encoder::HW_ENCODER_EDGE`, otherwise the
/// largest preset that lands inside the edge on both axes. scap resolves a
/// preset to `[W, W / aspect]` and clamps each axis to the captured size, so
/// the aspect ratio survives and the GPU does the scaling.
fn display_output_resolution(source_id: &str, crop: Option<CaptureCrop>) -> Resolution {
    let Some(("display", id_str)) = source_id.split_once(':') else {
        return Resolution::Captured;
    };
    let Ok(display_id) = id_str.parse::<u32>() else {
        return Resolution::Captured;
    };
    let bounds = CGDisplay::new(display_id).bounds();
    let (width_pts, height_pts) = match crop {
        Some(c) => (c.width, c.height),
        None => (bounds.size.width, bounds.size.height),
    };
    let scale = picker_sources::display_scale_factor(display_id);
    let (width, height) = picker_sources::points_to_even_pixels(width_pts, height_pts, scale);
    let resolution = preset_inside_hardware_edge(width, height);
    if !matches!(resolution, Resolution::Captured) {
        tracing::info!(
            source_id,
            width,
            height,
            ?resolution,
            "capture exceeds the hardware encoder edge; scaling on the GPU"
        );
    }
    resolution
}

/// scap's preset ladder, widest first, with the width each preset resolves
/// to. Mirrors `scap::capturer::Resolution::value` (0.0.8, pinned in
/// Cargo.toml): `[W, floor(W / aspect)]`, then per-axis `min` with the
/// captured size, then rounded down to even.
const SCAP_PRESETS: &[(Resolution, u32)] = &[
    (Resolution::_4320p, 7680),
    (Resolution::_2160p, 3840),
    (Resolution::_1440p, 2560),
    (Resolution::_1080p, 1920),
    (Resolution::_720p, 1280),
    (Resolution::_480p, 640),
];

/// What scap will hand out for `width`×`height` under `preset` — the clamp
/// from `get_output_frame_size`, reproduced so the pick can be checked against
/// the edge before the stream exists.
fn scap_output_size(width: u32, height: u32, preset_width: u32) -> (u32, u32) {
    let aspect = width as f32 / height as f32;
    let w = width.min(preset_width);
    let h = height.min((preset_width as f32 / aspect).floor() as u32);
    (w & !1, h & !1)
}

fn preset_inside_hardware_edge(width: u32, height: u32) -> Resolution {
    if width.max(height) <= hw_encoder::HW_ENCODER_EDGE || width == 0 || height == 0 {
        return Resolution::Captured;
    }
    for &(preset, preset_width) in SCAP_PRESETS {
        let (w, h) = scap_output_size(width, height, preset_width);
        if w.max(h) <= hw_encoder::HW_ENCODER_EDGE {
            return preset;
        }
    }
    Resolution::_480p
}

fn parse_source_id(source_id: &str) -> AppResult<u32> {
    let (kind, id_str) = source_id
        .split_once(':')
        .ok_or_else(|| AppError::InvalidSource(source_id.to_string()))?;
    if kind != "window" {
        return Err(AppError::InvalidSource(source_id.to_string()));
    }
    id_str
        .parse()
        .map_err(|_| AppError::InvalidSource(source_id.to_string()))
}

fn resolve_display_target(source_id: &str) -> AppResult<Target> {
    let (kind, id_str) = source_id
        .split_once(':')
        .ok_or_else(|| AppError::InvalidSource(source_id.to_string()))?;
    if kind != "display" {
        return Err(AppError::InvalidSource(source_id.to_string()));
    }
    let display_id: u32 = id_str
        .parse()
        .map_err(|_| AppError::InvalidSource(source_id.to_string()))?;
    for target in safe_scap_targets()? {
        if let Target::Display(d) = target {
            if d.id == display_id {
                return Ok(Target::Display(d));
            }
        }
    }
    Err(AppError::InvalidSource(format!("display:{display_id}")))
}

/// scap's `get_all_targets` panics when Screen Recording TCC is denied.
fn safe_scap_targets() -> AppResult<Vec<Target>> {
    match std::panic::catch_unwind(scap::get_all_targets) {
        Ok(targets) => Ok(targets),
        Err(_) => Err(AppError::PermissionDenied),
    }
}

/// Capptivo chrome (HUD / face-cam) out of `screen.mp4`, keyed by CGWindowID —
/// never by title. Editor / library / annotation stay capturable.
fn overlay_exclude_targets(exclude_ids: &[u32]) -> Option<Vec<Target>> {
    if exclude_ids.is_empty() {
        return None;
    }
    let excluded: Vec<Target> = safe_scap_targets()
        .unwrap_or_default()
        .into_iter()
        .filter(|t| match t {
            Target::Window(w) => exclude_ids.contains(&w.id),
            _ => false,
        })
        .collect();
    tracing::debug!(?exclude_ids, n = excluded.len(), "sck excluded overlays");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn same(a: Resolution, b: Resolution) -> bool {
        std::mem::discriminant(&a) == std::mem::discriminant(&b)
    }

    fn preset_width(preset: Resolution) -> u32 {
        SCAP_PRESETS
            .iter()
            .find(|(p, _)| same(*p, preset))
            .map(|(_, w)| *w)
            .expect("every non-Captured preset is in the ladder")
    }

    #[test]
    fn captures_inside_the_edge_keep_their_size() {
        assert!(same(preset_inside_hardware_edge(3840, 2160), Resolution::Captured));
        assert!(same(preset_inside_hardware_edge(4096, 2304), Resolution::Captured));
        assert!(same(preset_inside_hardware_edge(0, 9000), Resolution::Captured));
    }

    #[test]
    fn a_5k_display_lands_on_the_2160p_preset() {
        // 2560×1440 pt at 2× — scap resolves _2160p to [3840, 2160] here.
        assert!(same(preset_inside_hardware_edge(5120, 2880), Resolution::_2160p));
        assert_eq!(scap_output_size(5120, 2880, 3840), (3840, 2160));
        // An area of that display, 2560×1410 pt.
        assert!(same(preset_inside_hardware_edge(5120, 2820), Resolution::_2160p));
        assert_eq!(scap_output_size(5120, 2820, 3840), (3840, 2114));
    }

    #[test]
    fn a_portrait_5k_display_needs_a_smaller_preset() {
        // _2160p resolves to [3840, 6826] and the per-axis min keeps the
        // captured 5120 px height — only _1080p gets both axes under the edge.
        assert!(same(preset_inside_hardware_edge(2880, 5120), Resolution::_1080p));
        assert_eq!(scap_output_size(2880, 5120, 1920), (1920, 3412));
    }

    #[test]
    fn every_oversize_pick_fits_the_edge_under_scaps_clamp() {
        for (w, h) in [
            (5120, 2880),
            (5120, 2820),
            (2880, 5120),
            (10240, 4320),
            (6016, 3384),
            (4100, 4100),
            (7680, 2160),
        ] {
            let preset = preset_inside_hardware_edge(w, h);
            let (ow, oh) = scap_output_size(w, h, preset_width(preset));
            assert!(
                ow.max(oh) <= hw_encoder::HW_ENCODER_EDGE,
                "{w}x{h} → {preset:?} → {ow}x{oh}"
            );
            let aspect_in = w as f64 / h as f64;
            let aspect_out = ow as f64 / oh as f64;
            assert!(
                ((aspect_in - aspect_out) / aspect_in).abs() < 0.01,
                "{w}x{h} → {preset:?} → {ow}x{oh} changes the aspect ratio"
            );
        }
    }
}

//! Windows.Graphics.Capture backend via the `windows-capture` crate — the
//! Windows sibling of [`super::scap_backend`]. **This is the only file that
//! drives video through WGC**; system audio is a WASAPI loopback companion in
//! [`super::wasapi_audio`].
//!
//! Threading: `start_free_threaded` runs the capture session on its own
//! dispatcher-queue thread; [`FrameForwarder`] copies each frame into the
//! bounded channel. Output dimensions are resolved by a rendezvous on the first
//! frame (exact, instead of guessing DPI-scaled window bounds).
//!
//! Coordinate spaces: everything is **physical pixels** in the virtual-desktop
//! space — Tauri runs per-monitor-DPI-aware, so `GetCursorPos` (the cursor
//! sampler) and monitor/window rects agree without conversion. The one logical
//! input is [`RecorderConfig::crop`] (display-local points from the area
//! picker), converted here using the monitor's effective DPI.

use super::wasapi_audio::WasapiLoopback;
use super::win_preview;
use super::{CaptureBackend, CaptureHandle, RawFrame, CAPTURE_CHANNEL_CAP};
use crate::error::{AppError, AppResult};
use crate::recorder::types::{CaptureSource, CaptureSourceKind, RecorderConfig};
use crossbeam_channel::Sender;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

/// Sources smaller than this are noise (tooltips, hidden helpers), not targets.
const MIN_WINDOW_SIDE: i32 = 96;

pub struct WgcBackend;

impl WgcBackend {
    pub fn new() -> Self {
        Self
    }
}

impl CaptureBackend for WgcBackend {
    fn is_supported(&self) -> bool {
        GraphicsCaptureApi::is_supported().unwrap_or(false)
    }

    /// Windows has no screen-recording permission gate.
    fn has_permission(&self) -> bool {
        true
    }

    fn request_permission(&self) -> bool {
        true
    }

    fn list_sources(&self, include_thumbnails: bool) -> AppResult<Vec<CaptureSource>> {
        if !self.is_supported() {
            return Err(AppError::Unsupported);
        }

        let mut sources = Vec::new();

        let primary = Monitor::primary().ok().map(|m| m.as_raw_hmonitor() as isize);
        for monitor in Monitor::enumerate().map_err(|e| AppError::Other(e.to_string()))? {
            let id = monitor.as_raw_hmonitor() as isize;
            let title = monitor
                .name()
                .unwrap_or_else(|_| format!("Display {id}"));
            let width = monitor.width().unwrap_or(0);
            let height = monitor.height().unwrap_or(0);
            let preview = if include_thumbnails {
                win_preview::display_thumbnail(&monitor)
            } else {
                None
            };
            sources.push(CaptureSource {
                id: format!("display:{id}"),
                kind: CaptureSourceKind::Display,
                title,
                width,
                height,
                is_primary: Some(id) == primary,
                thumbnail: preview.map(|p| p.png_base64),
            });
        }

        // `Window::enumerate` already filters invisible, child, tool, and
        // own-process windows; add title/size guards for picker quality.
        for window in Window::enumerate().map_err(|e| AppError::Other(e.to_string()))? {
            let Ok(title) = window.title() else { continue };
            if title.trim().is_empty() {
                continue;
            }
            let (w, h) = (
                window.width().unwrap_or(0),
                window.height().unwrap_or(0),
            );
            if w < MIN_WINDOW_SIDE || h < MIN_WINDOW_SIDE {
                continue;
            }
            let id = window.as_raw_hwnd() as isize;
            let preview = if include_thumbnails {
                win_preview::window_thumbnail(&window)
            } else {
                None
            };
            sources.push(CaptureSource {
                id: format!("window:{id}"),
                kind: CaptureSourceKind::Window,
                title,
                width: w as u32,
                height: h as u32,
                is_primary: false,
                thumbnail: preview.map(|p| p.png_base64),
            });
        }

        Ok(sources)
    }

    fn start(&self, config: &RecorderConfig) -> AppResult<CaptureHandle> {
        if !self.is_supported() {
            return Err(AppError::Unsupported);
        }

        let fps = config.fps.clamp(1, 120);
        let target = resolve_target(&config.source_id)?;

        let (tx, rx) = crossbeam_channel::bounded::<RawFrame>(CAPTURE_CHANNEL_CAP);
        let (meta_tx, meta_rx) = crossbeam_channel::bounded::<([u32; 2], Instant)>(1);
        let dropped = Arc::new(AtomicU64::new(0));

        // Capture geometry (physical px) + scale, before frames start flowing.
        let (capture_rect, scale_factor, crop_px) = capture_geometry(&target, config)?;

        let flags = ForwarderFlags {
            tx,
            meta_tx,
            dropped: dropped.clone(),
            crop_px,
        };

        // Feature-support probes: requesting an unsupported toggle fails the
        // whole session on older Windows 10 builds, so fall back to Default.
        let cursor = if GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) {
            // Never bake the OS cursor into frames — Capptivo redraws a
            // customizable cursor in the editor from `cursor.json`.
            CursorCaptureSettings::WithoutCursor
        } else {
            CursorCaptureSettings::Default
        };
        let border = if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) {
            DrawBorderSettings::WithoutBorder
        } else {
            DrawBorderSettings::Default
        };
        // MinUpdateInterval is Win11 24H2+ (build ≥ 26100); Custom fails the
        // whole session on older builds. FramePacer still enforces target fps.
        let min_interval = if GraphicsCaptureApi::is_minimum_update_interval_supported()
            .unwrap_or(false)
        {
            MinimumUpdateIntervalSettings::Custom(Duration::from_secs_f64(1.0 / f64::from(fps)))
        } else {
            MinimumUpdateIntervalSettings::Default
        };

        let control = match target {
            Target::Monitor(monitor) => FrameForwarder::start_free_threaded(Settings::new(
                monitor,
                cursor,
                border,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            )),
            Target::Window(window) => FrameForwarder::start_free_threaded(Settings::new(
                window,
                cursor,
                border,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            )),
        }
        .map_err(|e| AppError::Other(format!("failed to start WGC capture: {e}")))?;

        // First frame carries the exact output size (crop-adjusted) plus the
        // timestamp epoch the forwarder anchored at session start.
        let ([width, height], epoch) = meta_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| AppError::Other("capture produced no frames".into()))?;

        let stop = move || {
            if let Err(e) = control.stop() {
                tracing::warn!(%e, "WGC capture stop failed");
            }
        };
        let mut handle = CaptureHandle::new(width, height, fps, rx, dropped, stop);
        handle.capture_rect = capture_rect;
        handle.scale_factor = scale_factor;
        handle.epoch = epoch;

        // Optional system-audio companion (WASAPI loopback on the output mix).
        if config.capture_system_audio {
            match WasapiLoopback::start() {
                Ok(tap) => {
                    let rx = tap.rx.clone();
                    handle.attach_audio(rx, move || drop(tap));
                }
                Err(e) => {
                    tracing::warn!(%e, "system audio unavailable; continuing video-only");
                }
            }
        }

        Ok(handle)
    }
}

/// A resolved capture target. HMONITOR/HWND values round-trip through source
/// ids as `isize` — stable for the session, which is all the picker needs.
enum Target {
    Monitor(Monitor),
    Window(Window),
}

fn resolve_target(source_id: &str) -> AppResult<Target> {
    let (kind, id_str) = source_id
        .split_once(':')
        .ok_or_else(|| AppError::InvalidSource(source_id.to_string()))?;
    let id: isize = id_str
        .parse()
        .map_err(|_| AppError::InvalidSource(source_id.to_string()))?;

    match kind {
        "display" => {
            let monitor = Monitor::enumerate()
                .map_err(|e| AppError::Other(e.to_string()))?
                .into_iter()
                .find(|m| m.as_raw_hmonitor() as isize == id)
                .ok_or_else(|| AppError::InvalidSource(source_id.to_string()))?;
            Ok(Target::Monitor(monitor))
        }
        "window" => {
            let window = Window::from_raw_hwnd(id as *mut std::ffi::c_void);
            if !window.is_valid() {
                return Err(AppError::InvalidSource(source_id.to_string()));
            }
            Ok(Target::Window(window))
        }
        _ => Err(AppError::InvalidSource(source_id.to_string())),
    }
}

/// Resolve the captured rect in physical virtual-desktop pixels, the monitor
/// scale factor, and the optional crop in frame-local physical pixels.
fn capture_geometry(
    target: &Target,
    config: &RecorderConfig,
) -> AppResult<(crate::cursor::CaptureRect, f64, Option<CropPx>)> {
    match target {
        Target::Monitor(monitor) => {
            let hmonitor = HMONITOR(monitor.as_raw_hmonitor());
            let rect = win_preview::monitor_rect(hmonitor)
                .ok_or_else(|| AppError::Other("monitor bounds unavailable".into()))?;
            let scale = win_preview::monitor_scale(hmonitor);

            match config.crop {
                Some(crop) => {
                    // Area-picker crops are display-local logical points.
                    let crop_px = CropPx {
                        x: (crop.x * scale).round().max(0.0) as u32,
                        y: (crop.y * scale).round().max(0.0) as u32,
                        width: (crop.width * scale).round().max(2.0) as u32,
                        height: (crop.height * scale).round().max(2.0) as u32,
                    };
                    let capture_rect = crate::cursor::CaptureRect {
                        x: rect.x + f64::from(crop_px.x),
                        y: rect.y + f64::from(crop_px.y),
                        width: f64::from(crop_px.width),
                        height: f64::from(crop_px.height),
                    };
                    Ok((capture_rect, scale, Some(crop_px)))
                }
                None => Ok((rect, scale, None)),
            }
        }
        Target::Window(window) => {
            let r = window
                .rect()
                .map_err(|e| AppError::Other(format!("window bounds: {e}")))?;
            let rect = crate::cursor::CaptureRect {
                x: f64::from(r.left),
                y: f64::from(r.top),
                width: f64::from(r.right - r.left).max(1.0),
                height: f64::from(r.bottom - r.top).max(1.0),
            };
            let scale = window
                .monitor()
                .map(|m| win_preview::monitor_scale(HMONITOR(m.as_raw_hmonitor())))
                .unwrap_or(1.0);
            Ok((rect, scale, None))
        }
    }
}

/// Crop rect in frame-local physical pixels (WGC `buffer_crop` bounds).
#[derive(Clone, Copy)]
struct CropPx {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

struct ForwarderFlags {
    tx: Sender<RawFrame>,
    meta_tx: Sender<([u32; 2], Instant)>,
    dropped: Arc<AtomicU64>,
    crop_px: Option<CropPx>,
}

/// Current QPC time in 100 ns units — the clock WGC frame timestamps
/// (`SystemRelativeTime`) are expressed in, and the clock backing
/// `std::time::Instant` on Windows. Reading it next to an `Instant::now()`
/// anchors the two time axes. Returns 0 if QPC is unavailable.
fn qpc_now_100ns() -> i64 {
    use windows::Win32::System::Performance::{
        QueryPerformanceCounter, QueryPerformanceFrequency,
    };
    let mut counts = 0i64;
    let mut freq = 0i64;
    unsafe {
        if QueryPerformanceCounter(&mut counts).is_err()
            || QueryPerformanceFrequency(&mut freq).is_err()
            || freq <= 0
        {
            return 0;
        }
    }
    (i128::from(counts) * 10_000_000 / i128::from(freq)) as i64
}

/// The WGC session callback: copies each frame (cropped if requested) into the
/// bounded channel, dropping (and counting) when the encoder falls behind.
struct FrameForwarder {
    flags: ForwarderFlags,
    /// QPC time (100 ns units) corresponding to `epoch` — frame timestamps are
    /// measured against this pair so they land on the cursor sampler's axis
    /// (see `CaptureHandle::epoch`). 0 when QPC could not be read.
    epoch_qpc: i64,
    /// The `Instant` reported to the controller as timestamp zero.
    epoch: Instant,
    /// Locked on the first frame; frames with other dims (window resize) are
    /// skipped — the encoder's dimensions are fixed for the session.
    expected: Option<[u32; 2]>,
}

impl GraphicsCaptureApiHandler for FrameForwarder {
    type Flags = ForwarderFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            flags: ctx.flags,
            epoch_qpc: qpc_now_100ns(),
            epoch: Instant::now(),
            expected: None,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let ts_raw = frame.timestamp().map(|t| t.Duration).unwrap_or(0);

        let mut buffer = match self.flags.crop_px {
            Some(c) => frame.buffer_crop(c.x, c.y, c.x + c.width, c.y + c.height)?,
            None => frame.buffer()?,
        };
        let width = buffer.width();
        let height = buffer.height();
        let bytes_per_row = buffer.row_pitch();
        if width == 0 || height == 0 {
            return Ok(());
        }

        match self.expected {
            None => {
                self.expected = Some([width, height]);
                let _ = self.flags.meta_tx.send(([width, height], self.epoch));
            }
            Some(expected) if expected != [width, height] => {
                // Window resized mid-recording; keep the session dimensions.
                return Ok(());
            }
            Some(_) => {}
        }

        // Presentation time on the shared epoch axis (see `CaptureHandle::epoch`).
        let timestamp = if ts_raw > 0 && self.epoch_qpc > 0 {
            Duration::from_nanos(ts_raw.saturating_sub(self.epoch_qpc).max(0) as u64 * 100)
        } else {
            // No PTS / no QPC — receipt time is the best remaining estimate.
            self.epoch.elapsed()
        };

        let raw = RawFrame {
            width,
            height,
            bytes_per_row,
            data: buffer.as_raw_buffer().to_vec(),
            timestamp,
        };

        match self.flags.tx.try_send(raw) {
            Ok(()) => {}
            Err(crossbeam_channel::TrySendError::Full(_)) => {
                self.flags.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(crossbeam_channel::TrySendError::Disconnected(_)) => {
                // Encoder is gone — the session is being torn down.
            }
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // Captured window closed: dropping the sender disconnects the channel,
        // which ends the encode loop cleanly with whatever was recorded.
        Ok(())
    }
}

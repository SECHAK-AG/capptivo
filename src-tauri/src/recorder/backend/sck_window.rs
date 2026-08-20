//! Per-window video capture via ScreenCaptureKit (`DesktopIndependentWindow`).
//!
//! Encoder dimensions come from the **first CVPixelBuffer** SCK emits — never from
//! a precomputed guess. That keeps `CaptureHandle` width/height aligned with what
//! FFmpeg actually receives (avoids letterboxing / black bars on the right).

use super::picker_sources;
use super::RawFrame;
use crate::cursor::CaptureRect;
use crate::error::{AppError, AppResult};
use crate::recorder::hw_encoder;
use crossbeam_channel::{Sender, TrySendError};
use objc::{msg_send, sel, sel_impl};
use objc_id::Id;
use screencapturekit_sys::cm_sample_buffer_ref::CMSampleBufferRef;
use screencapturekit_sys::content_filter::{UnsafeContentFilter, UnsafeInitParams};
use screencapturekit_sys::cv_pixel_buffer_ref::CVPixelBufferRef;
use screencapturekit_sys::os_types::base::{BOOL, CMTime, CMTimeScale};
use screencapturekit_sys::sc_stream_frame_info::SCFrameStatus;
use screencapturekit_sys::shareable_content::{UnsafeSCDisplay, UnsafeSCWindow};
use objc_id::ShareId;
use screencapturekit_sys::stream::UnsafeSCStream;
use screencapturekit_sys::stream_configuration::{
    UnsafeStreamConfiguration, UnsafeStreamConfigurationRef,
};
use screencapturekit_sys::stream_error_handler::UnsafeSCStreamError;
use screencapturekit_sys::stream_output_handler::UnsafeSCStreamOutput;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const OUTPUT_TYPE_SCREEN: u8 = 0;
/// How long `start()` waits for the first frame before failing window capture.
pub const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);

struct QuietErrors;
impl UnsafeSCStreamError for QuietErrors {
    fn handle_error(&self) {
        tracing::warn!("window SCStream error");
    }
}

/// Fires once with the pixel size of the first complete frame (encoder contract).
struct ReadyGate {
    tx: Mutex<Option<Sender<AppResult<([u32; 2], Instant, u64)>>>>,
    epoch: Instant,
    epoch_host_ns: u64,
    done: AtomicBool,
}

impl ReadyGate {
    fn new(
        tx: Sender<AppResult<([u32; 2], Instant, u64)>>,
        epoch: Instant,
        epoch_host_ns: u64,
    ) -> Self {
        Self {
            tx: Mutex::new(Some(tx)),
            epoch,
            epoch_host_ns,
            done: AtomicBool::new(false),
        }
    }

    fn signal(&self, width: u32, height: u32) {
        if self.done.swap(true, Ordering::Relaxed) {
            return;
        }
        let Some(tx) = self.tx.lock().unwrap().take() else {
            return;
        };
        let _ = tx.send(Ok(([width, height], self.epoch, self.epoch_host_ns)));
    }

    fn fail(&self, err: AppError) {
        if self.done.swap(true, Ordering::Relaxed) {
            return;
        }
        let Some(tx) = self.tx.lock().unwrap().take() else {
            return;
        };
        let _ = tx.send(Err(err));
    }
    fn was_signaled(&self) -> bool {
        self.done.load(Ordering::Relaxed)
    }
}

struct VideoOut {
    tx: Sender<RawFrame>,
    dropped: Arc<AtomicU64>,
    epoch_host_ns: u64,
    epoch: Instant,
    ready: Arc<ReadyGate>,
}

impl UnsafeSCStreamOutput for VideoOut {
    fn did_output_sample_buffer(&self, sample: Id<CMSampleBufferRef>, of_type: u8) {
        if of_type != OUTPUT_TYPE_SCREEN {
            return;
        }
        match sample.get_frame_info().status() {
            SCFrameStatus::Complete | SCFrameStatus::Started => {}
            _ => return,
        }
        let Some(image_buf) = sample.get_image_buffer() else {
            return;
        };
        let pixel = image_buf.as_pixel_buffer();
        let Some(raw) = copy_bgra_frame(&pixel, &sample, self.epoch_host_ns, self.epoch) else {
            return;
        };
        self.ready.signal(raw.width, raw.height);
        match self.tx.try_send(raw) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

/// Start capturing a single window. Signals `ready` on the first frame (or `Err`
/// if setup fails / no frames before stop).
pub fn run_window_capture(
    window_id: u32,
    fps: u32,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    tx: Sender<RawFrame>,
    ready: Sender<AppResult<([u32; 2], Instant, u64)>>,
) {
    if let Err(e) = run_window_capture_inner(window_id, fps, stop, dropped, tx, ready.clone()) {
        let _ = ready.send(Err(e));
    }
}

fn run_window_capture_inner(
    window_id: u32,
    fps: u32,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    tx: Sender<RawFrame>,
    ready: Sender<AppResult<([u32; 2], Instant, u64)>>,
) -> AppResult<()> {
    let content = picker_sources::shareable_content_on_screen()
        .map_err(|e| AppError::Other(format!("SCShareableContent: {e}")))?;

    let window = content
        .windows()
        .into_iter()
        .find(|w| w.get_window_id() == window_id)
        .ok_or_else(|| {
            AppError::InvalidSource(
                "This window is not visible on screen — click its Dock icon or switch to its Space."
                    .into(),
            )
        })?;

    let displays = content.displays();
    let native = stream_config_pixels(&window, &displays);
    // A window wider than the hardware encoder takes is scaled by SCK on the
    // GPU rather than encoded in software at full size (see
    // `hw_encoder::HW_ENCODER_EDGE`). `scales_to_fit` is what makes SCK honour
    // a size other than the window's own; the target keeps the window's aspect
    // ratio, so nothing is letterboxed.
    let scaled = hw_encoder::fit_to_hardware_edge(native.0, native.1);
    let (cfg_w, cfg_h) = scaled.unwrap_or(native);
    if let Some((w, h)) = scaled {
        tracing::info!(
            window_id,
            native_width = native.0,
            native_height = native.1,
            width = w,
            height = h,
            "window exceeds the hardware encoder edge; scaling on the GPU"
        );
    }
    let filter = UnsafeContentFilter::init(UnsafeInitParams::DesktopIndependentWindow(window));

    let config = UnsafeStreamConfiguration {
        width: cfg_w,
        height: cfg_h,
        scales_to_fit: BOOL::from(scaled.is_some()),
        queue_depth: 6,
        shows_cursor: 0,
        minimum_frame_interval: CMTime {
            value: 1,
            timescale: fps.max(1) as CMTimeScale,
            epoch: 0,
            flags: 1,
        },
        ..Default::default()
    };
    let config_ref: Id<UnsafeStreamConfigurationRef> = config.into();
    tune_window_stream_config(&config_ref);

    let epoch = Instant::now();
    let epoch_host_ns = host_clock_ns();
    let ready_gate = Arc::new(ReadyGate::new(ready, epoch, epoch_host_ns));
    let stream = UnsafeSCStream::init(filter, config_ref, QuietErrors);
    stream.add_stream_output(
        VideoOut {
            tx,
            dropped,
            epoch_host_ns,
            epoch,
            ready: ready_gate.clone(),
        },
        OUTPUT_TYPE_SCREEN,
    );
    stream
        .start_capture()
        .map_err(|e| AppError::Other(format!("failed to start window capture: {e}")))?;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
    }
    // `UnsafeSCStream::drop` calls `stop_capture()`, which can block for seconds.
    // Teardown off-thread so stop→start on the same window does not wedge the
    // next session waiting for SCK to release the window.
    let _ = std::thread::Builder::new()
        .name("sck-window-teardown".into())
        .spawn(move || drop(stream));
    if !ready_gate.was_signaled() {
        ready_gate.fail(AppError::Other(
            "window capture stopped before the first frame".into(),
        ));
    }
    Ok(())
}

/// SCK stream size hint — truncate, not round. Encoder
/// dimensions still come from the first CVPixelBuffer, not this value.
fn stream_config_pixels(window: &UnsafeSCWindow, displays: &[ShareId<UnsafeSCDisplay>]) -> (u32, u32) {
    let f = window.get_frame();
    let rect = CaptureRect {
        x: f.origin.x,
        y: f.origin.y,
        width: f.size.width,
        height: f.size.height,
    };
    let display_id = picker_sources::display_for_window_frame(&rect, displays)
        .unwrap_or_else(|| core_graphics::display::CGDisplay::main().id);
    let scale = picker_sources::display_scale_factor(display_id);
    picker_sources::points_to_even_pixels(rect.width, rect.height, scale)
}

/// macOS 14+: exclude window shadow from single-window capture.
fn tune_window_stream_config(config_ref: &UnsafeStreamConfigurationRef) {
    unsafe {
        let _: () = msg_send![config_ref, setIgnoreShadowsSingleWindow: BOOL::from(true)];
    }
}

fn copy_bgra_frame(
    pixel: &CVPixelBufferRef,
    sample: &CMSampleBufferRef,
    epoch_host_ns: u64,
    epoch: Instant,
) -> Option<RawFrame> {
    const READ_ONLY: u64 = 1;
    unsafe {
        if pixel.lock_base_address(READ_ONLY) != 0 {
            return None;
        }
        let base = pixel.get_base_address();
        let pb = pixel as *const CVPixelBufferRef as *mut c_void;
        let width = CVPixelBufferGetWidth(pb) as u32;
        let height = CVPixelBufferGetHeight(pb) as u32;
        let bytes_per_row = CVPixelBufferGetBytesPerRow(pb) as u32;

        let data = if base.is_null() || width == 0 || height == 0 {
            None
        } else {
            let len = bytes_per_row as usize * height as usize;
            let mut buf = Vec::<u8>::with_capacity(len);
            std::ptr::copy_nonoverlapping(base as *const u8, buf.as_mut_ptr(), len);
            buf.set_len(len);
            Some(buf)
        };
        pixel.unlock_base_address(READ_ONLY);
        let data = data?;

        let pts_ns = cmtime_to_ns(sample.get_presentation_timestamp());
        let timestamp = if pts_ns > 0 {
            Duration::from_nanos(pts_ns.saturating_sub(epoch_host_ns))
        } else {
            epoch.elapsed()
        };

        Some(RawFrame {
            width,
            height,
            bytes_per_row,
            data,
            timestamp,
        })
    }
}

fn cmtime_to_ns(ts: CMTime) -> u64 {
    if ts.timescale == 0 {
        return 0;
    }
    let num = ts.value as i128 * 1_000_000_000;
    let den = ts.timescale as i128;
    (num / den).max(0) as u64
}

fn host_clock_ns() -> u64 {
    extern "C" {
        fn clock_gettime_nsec_np(clock_id: u32) -> u64;
    }
    const CLOCK_UPTIME_RAW: u32 = 8;
    unsafe { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }
}

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferGetWidth(pb: *mut c_void) -> usize;
    fn CVPixelBufferGetHeight(pb: *mut c_void) -> usize;
    fn CVPixelBufferGetBytesPerRow(pb: *mut c_void) -> usize;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmtime_to_ns_converts_seconds() {
        let ts = CMTime {
            value: 2,
            timescale: 1,
            epoch: 0,
            flags: 1,
        };
        assert_eq!(cmtime_to_ns(ts), 2_000_000_000);
    }

    #[test]
    fn ready_gate_signals_once() {
        let (tx, rx) = crossbeam_channel::bounded(1);
        let epoch = Instant::now();
        let gate = ReadyGate::new(tx, epoch, 0);
        gate.signal(640, 480);
        gate.signal(800, 600);
        let (size, got_epoch, host_ns) = rx.recv().unwrap().unwrap();
        assert_eq!(size, [640, 480]);
        assert_eq!(got_epoch, epoch);
        assert_eq!(host_ns, 0);
    }
}

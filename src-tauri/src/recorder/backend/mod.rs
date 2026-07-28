//! The capture port. `CaptureBackend` is the seam that isolates ScreenCaptureKit
//! (via `scap`) from the rest of the pipeline — per TAURI_DESKTOP_MIGRATION.md §15,
//! this makes swapping to raw `screencapturekit`/`objc2` bindings (or adding a
//! Windows Graphics Capture backend) a contained change, and lets the encoder be
//! unit-tested against a synthetic backend with no display or TCC permission.

use crate::error::AppResult;
use crate::recorder::types::{CaptureDevice, CaptureSource, RecorderConfig};
use crossbeam_channel::Receiver;
use std::time::{Duration, Instant};

mod router;
pub use router::RoutingBackend;

mod test_pattern;
pub use test_pattern::TestPatternBackend;

// iOS device capture is CoreMediaIO + AVFoundation only — no ScreenCaptureKit,
// so it builds even with `--no-default-features`.
#[cfg(target_os = "macos")]
mod avf_device;
#[cfg(target_os = "macos")]
pub use avf_device::{AvfDeviceBackend, DEVICE_ID_PREFIX};

#[cfg(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture")
))]
mod preview;

#[cfg(all(target_os = "macos", feature = "scap-capture"))]
mod picker_sources;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
mod scap_backend;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
mod source_preview;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
mod system_audio;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
pub use scap_backend::ScapBackend;

#[cfg(all(target_os = "windows", feature = "wgc-capture"))]
mod wasapi_audio;
#[cfg(all(target_os = "windows", feature = "wgc-capture"))]
mod wgc_backend;
#[cfg(all(target_os = "windows", feature = "wgc-capture"))]
pub(crate) mod win_preview;
#[cfg(all(target_os = "windows", feature = "wgc-capture"))]
pub use wgc_backend::WgcBackend;

#[cfg(all(target_os = "linux", feature = "portal-capture"))]
mod portal_backend;
#[cfg(all(target_os = "linux", feature = "portal-capture"))]
mod pulse_audio;
#[cfg(all(target_os = "linux", feature = "portal-capture"))]
pub use portal_backend::PortalBackend;

/// A single captured frame in BGRA8888, tagged with a presentation timestamp
/// measured from [`CaptureHandle::epoch`]. That epoch is the contract that
/// keeps cursor data and camera chunks frame-accurate against the video in
/// the editor: the cursor sampler stamps against the *same* `Instant`, so the
/// two timelines share one clock. Rebasing to "the first frame" instead is the
/// classic bug — the first frame lands hundreds of ms after record-start, and
/// every cursor sample then leads the video by exactly that warm-up gap.
pub struct RawFrame {
    // `width`/`height`/`timestamp` are carried for validation and for camera/
    // cursor sync (Phase 4); the encoder itself only needs `data` + stride.
    #[allow(dead_code)]
    pub width: u32,
    #[allow(dead_code)]
    pub height: u32,
    /// Row stride in bytes. May exceed `width * 4` due to alignment padding;
    /// the encoder must honor it.
    pub bytes_per_row: u32,
    /// BGRA pixel data, `height * bytes_per_row` bytes.
    pub data: Vec<u8>,
    #[allow(dead_code)]
    pub timestamp: Duration,
}

/// One system-audio packet (interleaved f32le PCM) from the platform tap
/// (ScreenCaptureKit / WASAPI loopback / PulseAudio monitor).
pub struct RawAudio {
    /// Interleaved little-endian `f32` samples.
    pub data: Vec<u8>,
    pub sample_rate: u32,
    pub channels: u16,
}

/// A live capture session: a bounded frame channel plus a stop switch.
///
/// The channel is bounded (see `CAPTURE_CHANNEL_CAP`) so that if the encoder
/// falls behind, the producer drops the oldest frames and counts them rather
/// than growing memory without bound.
pub struct CaptureHandle {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames: Receiver<RawFrame>,
    /// System-audio packets when `RecorderConfig::capture_system_audio` is on.
    pub audio: Option<Receiver<RawAudio>>,
    /// Frames the producer had to drop because the channel was full.
    pub dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Captured source rect in global points, for cursor-sample normalization.
    /// Defaults to the pixel size at scale 1.0 (fine for the synthetic backend).
    pub capture_rect: crate::cursor::CaptureRect,
    /// Display backing scale factor (points → pixels).
    pub scale_factor: f64,
    /// Whether the Mac's pointer belongs on this timeline. False for iOS device
    /// capture: the frames are the *phone's* screen, so sampling the Mac cursor
    /// would write a cursor track that has nothing to do with the video.
    pub tracks_cursor: bool,
    /// The `Instant` that frame timestamps are measured from. The controller
    /// starts the cursor sampler on this same instant, which is what keeps the
    /// replayed cursor glued to the pixels it was recorded over — any epoch
    /// skew between the two shows up as the cursor trailing/leading the video,
    /// magnified by zoom.
    pub epoch: Instant,
    stop: Option<Box<dyn FnOnce() + Send>>,
}

impl CaptureHandle {
    pub fn new(
        width: u32,
        height: u32,
        fps: u32,
        frames: Receiver<RawFrame>,
        dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
        stop: impl FnOnce() + Send + 'static,
    ) -> Self {
        Self {
            width,
            height,
            fps,
            frames,
            audio: None,
            dropped,
            capture_rect: crate::cursor::CaptureRect {
                x: 0.0,
                y: 0.0,
                width: width as f64,
                height: height as f64,
            },
            tracks_cursor: true,
            scale_factor: 1.0,
            // Handle construction happens as the producer comes up; backends
            // whose source clock can be anchored precisely overwrite this.
            epoch: Instant::now(),
            stop: Some(Box::new(stop)),
        }
    }

    /// Attach a system-audio receiver and an extra stop hook (e.g. tear down the
    /// companion SCStream). Video stops first so the encode loop unblocks;
    /// audio teardown runs after and must not block finalize.
    pub fn attach_audio(
        &mut self,
        rx: Receiver<RawAudio>,
        on_stop: impl FnOnce() + Send + 'static,
    ) {
        self.audio = Some(rx);
        let prev = self.stop.take();
        self.stop = Some(Box::new(move || {
            if let Some(stop) = prev {
                stop();
            }
            on_stop();
        }));
    }

    /// Stop capture. The frame channel closes shortly after, ending the encode
    /// loop. Idempotent.
    pub fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Bounded capacity of the capture→encode channel. ~8 frames ≈ 260 ms of slack
/// at 30fps before we start dropping — enough to ride out GC/scheduler jitter,
/// small enough to bound memory (a 4K BGRA frame is ~33 MB, so 8 ≈ 265 MB worst
/// case; the encoder normally keeps this near-empty).
pub const CAPTURE_CHANNEL_CAP: usize = 8;

/// Audio packets are tiny vs video frames; allow more slack so a brief encode
/// stall doesn't drop system audio.
pub const AUDIO_CHANNEL_CAP: usize = 64;

/// The port implemented by every capture source.
pub trait CaptureBackend: Send + Sync {
    /// Whether this backend can run on the current system.
    fn is_supported(&self) -> bool;

    /// Whether screen-recording permission (TCC) is granted.
    fn has_permission(&self) -> bool;

    /// Ask the OS to prompt for screen-recording permission. Returns the state
    /// after asking (macOS still requires an app restart to take effect).
    fn request_permission(&self) -> bool;

    /// Enumerate displays and windows for the picker.
    fn list_sources(&self) -> AppResult<Vec<CaptureSource>>;

    /// Enumerate attached iOS devices (iPhone / iPad screen capture over USB).
    ///
    /// Deliberately *not* folded into [`Self::list_sources`]: these are not
    /// displays or windows, they come from a different framework, and they are
    /// gated by camera permission rather than screen-recording permission.
    /// Backends without a device story inherit the empty default.
    fn list_devices(&self) -> AppResult<Vec<CaptureDevice>> {
        Ok(Vec::new())
    }

    /// Begin capturing. Spawns the producer thread and returns immediately with a
    /// live [`CaptureHandle`].
    fn start(&self, config: &RecorderConfig) -> AppResult<CaptureHandle>;
}

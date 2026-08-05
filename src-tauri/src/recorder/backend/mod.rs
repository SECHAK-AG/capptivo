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
#[cfg(target_os = "macos")]
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
pub(crate) mod picker_sources;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
mod sck_window;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
pub(crate) mod window_prepare;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
pub(crate) use window_prepare::prepare_for_capture;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
mod scap_backend;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
mod source_preview;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
mod system_audio;
#[cfg(all(target_os = "macos", feature = "scap-capture"))]
pub use scap_backend::ScapBackend;

#[cfg(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture"),
))]
pub(crate) mod cpal_mic;

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

/// One system-audio / mic packet (interleaved f32le PCM) from the platform tap
/// (ScreenCaptureKit / WASAPI loopback / PulseAudio monitor).
pub struct RawAudio {
    /// Interleaved little-endian `f32` samples.
    pub data: Vec<u8>,
    pub sample_rate: u32,
    pub channels: u16,
    /// Capture time on the same axis as [`RawFrame::timestamp`]
    /// ([`CaptureHandle::epoch`]). Used to pad leading silence so A/V share one
    /// timeline instead of appending PCM in arrival order.
    pub timestamp: Duration,
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
    /// Native mic packets when `RecorderConfig::capture_microphone` is on.
    pub mic: Option<Receiver<RawAudio>>,
    /// Frames the producer had to drop because the channel was full.
    pub dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Shared with the producer so the encode loop can hand finished frame
    /// buffers back for reuse.
    ///
    /// `None` for backends that allocate their own frames, and it must stay
    /// that way for them: the pacer would otherwise park up to
    /// [`FRAME_POOL_CAP`] buffers (~330 MB at 4K) that no producer ever draws
    /// back out, turning a free into a leak-shaped retention.
    pub pool: Option<FrameBufferPool>,
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
            mic: None,
            dropped,
            pool: None,
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
        self.chain_stop(on_stop);
    }

    /// Attach a native microphone receiver (cpal / Pulse). Same stop-hook
    /// rules as [`Self::attach_audio`].
    pub fn attach_mic(
        &mut self,
        rx: Receiver<RawAudio>,
        on_stop: impl FnOnce() + Send + 'static,
    ) {
        self.mic = Some(rx);
        self.chain_stop(on_stop);
    }

    fn chain_stop(&mut self, on_stop: impl FnOnce() + Send + 'static) {
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

/// Buffers the pool will hold: the channel's depth, plus the one the pacer
/// retains for gap-fill, plus the one the producer is filling. That is exactly
/// how many the pipeline already has in hand at peak, so pooling does not raise
/// the high-water mark — it just stops the allocator seeing the churn.
const FRAME_POOL_CAP: usize = CAPTURE_CHANNEL_CAP + 2;

/// Recycles capture frame buffers so the hot path stops hitting the allocator.
///
/// A 4K BGRA frame is ~33 MB. Allocations that size skip the heap's free lists
/// and go straight to `VirtualAlloc`/`VirtualFree`, and every page of a fresh
/// mapping faults on first touch — so `to_vec()`-ing one frame costs ~8100 page
/// faults on top of the copy, and the pipeline does that 60 times a second.
/// Faulting in the pages costs several times the `memcpy` that follows it.
/// Recycled buffers are already mapped and resident, so the per-frame cost
/// drops to the copy alone, which is irreducible.
///
/// Bounded at [`FRAME_POOL_CAP`] and never blocking: an empty pool allocates,
/// because stalling a capture callback is worse than one allocation.
///
/// Cheap to clone — every clone shares one pool. The producer and the encode
/// loop run on different threads and both hold one.
#[derive(Clone, Default)]
pub struct FrameBufferPool {
    buffers: std::sync::Arc<parking_lot::Mutex<Vec<Vec<u8>>>>,
}

impl FrameBufferPool {
    // Only the Windows capture backend builds and fills a pool; elsewhere the
    // tests below are the only callers, which `dead_code` analysis ignores.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn new() -> Self {
        Self::default()
    }

    /// A buffer holding a copy of `src`, reusing a pooled allocation when one
    /// is available.
    ///
    /// `clear` + `extend_from_slice` rather than `resize`/`vec![0; n]` on
    /// purpose: those zero-fill, which would write every byte twice — once with
    /// zeros and once with the frame. `clear` is free for `u8` (nothing to
    /// drop) and leaves the capacity in place, so the copy lands straight into
    /// already-resident pages. It also sets the length from `src`, so a
    /// recycled buffer can never leak bytes of the frame before it.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn fill_from(&self, src: &[u8]) -> Vec<u8> {
        let mut buf = self.buffers.lock().pop().unwrap_or_default();
        buf.clear();
        buf.extend_from_slice(src);
        buf
    }

    /// Hand a finished buffer back. Dropped on the floor once the pool is full,
    /// which is what keeps the bound hard.
    ///
    /// Only call this where the buffer is provably finished — the frame the
    /// pacer just displaced, or one the channel refused. Returning a buffer the
    /// encoder still references would let the next frame overwrite it mid-write.
    pub fn put(&self, mut buffer: Vec<u8>) {
        if buffer.capacity() == 0 {
            return;
        }
        let mut pool = self.buffers.lock();
        if pool.len() >= FRAME_POOL_CAP {
            return;
        }
        buffer.clear();
        pool.push(buffer);
    }

    /// Buffers currently parked in the pool. Test-only.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.buffers.lock().len()
    }
}

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
    ///
    /// `include_thumbnails == false` skips per-source preview capture. The
    /// recorder calls that form at launch, when no picker menu is open and the
    /// previews would be thrown away — capturing them costs one full-resolution
    /// screenshot per display *and* per window (see `source_preview.rs`).
    fn list_sources(&self, include_thumbnails: bool) -> AppResult<Vec<CaptureSource>>;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_allocates_when_empty_and_copies_the_source() {
        let pool = FrameBufferPool::new();
        let got = pool.fill_from(&[1, 2, 3, 4]);
        assert_eq!(got, vec![1, 2, 3, 4]);
    }

    #[test]
    fn pool_reuses_the_same_allocation() {
        let pool = FrameBufferPool::new();
        let first = pool.fill_from(&[7u8; 4096]);
        let addr = first.as_ptr();
        pool.put(first);

        let second = pool.fill_from(&[9u8; 4096]);
        assert_eq!(
            second.as_ptr(),
            addr,
            "a pooled buffer must be handed back, not reallocated"
        );
        assert!(second.iter().all(|b| *b == 9), "contents must be the new frame");
    }

    #[test]
    fn pool_never_leaks_bytes_of_the_previous_frame() {
        // The regression that would corrupt video: a recycled buffer must be
        // truncated to the new frame, never padded with the old one's tail.
        let pool = FrameBufferPool::new();
        pool.put(pool.fill_from(&[0xAAu8; 64]));
        let shorter = pool.fill_from(&[0xBBu8; 8]);
        assert_eq!(shorter.len(), 8, "length must follow the source exactly");
        assert!(shorter.iter().all(|b| *b == 0xBB), "no stale bytes may survive");
    }

    #[test]
    fn pool_is_bounded() {
        let pool = FrameBufferPool::new();
        for _ in 0..FRAME_POOL_CAP * 3 {
            pool.put(vec![0u8; 16]);
        }
        assert_eq!(pool.len(), FRAME_POOL_CAP, "the pool must not grow without bound");
    }

    #[test]
    fn pool_ignores_empty_buffers() {
        let pool = FrameBufferPool::new();
        pool.put(Vec::new());
        assert_eq!(pool.len(), 0, "a zero-capacity buffer is not worth parking");
    }

    #[test]
    fn pool_clones_share_one_set_of_buffers() {
        // The producer and the encode loop hold separate clones; a buffer
        // returned by one must be visible to the other.
        let producer = FrameBufferPool::new();
        let consumer = producer.clone();
        consumer.put(vec![0u8; 32]);
        assert_eq!(producer.len(), 1);
    }
}

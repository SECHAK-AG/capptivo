//! A synthetic capture backend that emits a moving test pattern. Always compiled
//! (all platforms, no feature gate) so the encoder + project pipeline can be
//! exercised by `cargo test` on any machine, with no display and no TCC prompt.

use super::{CaptureBackend, CaptureHandle, RawFrame, CAPTURE_CHANNEL_CAP};
use crate::error::AppResult;
use crate::recorder::types::{CaptureSource, CaptureSourceKind, RecorderConfig};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Fixed output size for the synthetic source. 640×360 keeps test MP4s tiny.
const W: u32 = 640;
const H: u32 = 360;

pub struct TestPatternBackend {
    /// If set, the producer stops after this many frames (keeps tests bounded).
    /// Dropping the sender disconnects the channel, which the encode loop reads
    /// as "the capture ended".
    pub max_frames: Option<u64>,
    /// If set, the producer stops *sending* after this many frames but holds the
    /// channel open — a screen that has gone still. This is what
    /// Windows.Graphics.Capture does when nothing on screen changes, and it is
    /// deliberately different from `max_frames`: the session is alive and the
    /// user is still recording, there is simply nothing new to send.
    pub quiet_after: Option<u64>,
    /// Render this many leading frames as pure black. Mirrors a capture that
    /// hands over an unpainted surface before the source draws anything — the
    /// frames `is_capture_warmup_black` is meant to skip.
    pub black_frames: u64,
}

impl Default for TestPatternBackend {
    fn default() -> Self {
        Self {
            max_frames: None,
            quiet_after: None,
            black_frames: 0,
        }
    }
}

impl CaptureBackend for TestPatternBackend {
    fn is_supported(&self) -> bool {
        true
    }
    fn has_permission(&self) -> bool {
        true
    }
    fn request_permission(&self) -> bool {
        true
    }

    fn list_sources(&self, _include_thumbnails: bool) -> AppResult<Vec<CaptureSource>> {
        Ok(vec![CaptureSource {
            id: "display:test".into(),
            kind: CaptureSourceKind::Display,
            title: "Test Pattern".into(),
            width: W,
            height: H,
            is_primary: true,
            thumbnail: None,
        }])
    }

    fn start(&self, config: &RecorderConfig) -> AppResult<CaptureHandle> {
        let fps = config.fps.clamp(1, 120);
        let (tx, rx) = crossbeam_channel::bounded::<RawFrame>(CAPTURE_CHANNEL_CAP);
        let stop_flag = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));
        let max_frames = self.max_frames;
        let quiet_after = self.quiet_after;
        let black_frames = self.black_frames;

        let producer_stop = stop_flag.clone();
        let producer_dropped = dropped.clone();
        std::thread::spawn(move || {
            let t0 = Instant::now();
            let frame_interval = Duration::from_secs_f64(1.0 / fps as f64);
            let mut n: u64 = 0;
            while !producer_stop.load(Ordering::Relaxed) {
                if let Some(max) = max_frames {
                    if n >= max {
                        break;
                    }
                }
                // Gone still: hold the channel open and send nothing, the way a
                // capture backend behaves when the screen stops changing.
                if quiet_after.is_some_and(|q| n >= q) {
                    std::thread::sleep(frame_interval);
                    continue;
                }
                let frame = if n < black_frames {
                    render_black_frame(t0.elapsed())
                } else {
                    render_frame(n, t0.elapsed())
                };
                // Non-blocking send: if the consumer is behind, drop and count.
                match tx.try_send(frame) {
                    Ok(()) => {}
                    Err(crossbeam_channel::TrySendError::Full(_)) => {
                        producer_dropped.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(crossbeam_channel::TrySendError::Disconnected(_)) => break,
                }
                n += 1;
                std::thread::sleep(frame_interval);
            }
        });

        let stop = {
            let stop_flag = stop_flag.clone();
            move || stop_flag.store(true, Ordering::Relaxed)
        };
        Ok(CaptureHandle::new(W, H, fps, rx, dropped, stop))
    }
}

/// An all-black frame: what a capture surface looks like before the source has
/// painted into it.
fn render_black_frame(elapsed: Duration) -> RawFrame {
    let bytes_per_row = W * 4;
    let mut data = vec![0u8; (bytes_per_row * H) as usize];
    for px in data.chunks_exact_mut(4) {
        px[3] = 255; // opaque black
    }
    RawFrame {
        width: W,
        height: H,
        bytes_per_row,
        data,
        timestamp: elapsed,
    }
}

/// A diagonal color gradient with a bright block sweeping left→right so the frame
/// visibly changes over time (encoders and eyeballing both like motion).
fn render_frame(n: u64, elapsed: Duration) -> RawFrame {
    let bytes_per_row = W * 4;
    let mut data = vec![0u8; (bytes_per_row * H) as usize];
    let sweep_x = (n % W as u64) as u32;
    for y in 0..H {
        for x in 0..W {
            let i = (y * bytes_per_row + x * 4) as usize;
            let bright = x.abs_diff(sweep_x) < 16;
            // BGRA
            data[i] = if bright { 255 } else { (x * 255 / W) as u8 }; // B
            data[i + 1] = (y * 255 / H) as u8; // G
            data[i + 2] = if bright { 255 } else { ((x + y) * 255 / (W + H)) as u8 }; // R
            data[i + 3] = 255; // A
        }
    }
    RawFrame {
        width: W,
        height: H,
        bytes_per_row,
        data,
        timestamp: elapsed,
    }
}

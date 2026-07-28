//! The recorder controller: the state machine that owns the capture → encode →
//! cursor pipeline. It is **Tauri-free** (per §14) so it can be unit-tested with
//! the synthetic backend; the `commands` layer injects the event `emit` closure
//! and the project directory, and finalizes the returned artifacts into a project.

pub mod backend;
pub mod encoder;
pub mod hw_encoder;
pub mod types;

use crate::cursor::{CursorTrack, CursorTracker};
use crate::error::{AppError, AppResult};
use backend::{CaptureBackend, CaptureHandle, RawAudio};
use encoder::Encoder;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use types::{
    CaptureDevice, CaptureSource, CaptureStats, RecorderConfig, RecorderEvent, RecorderState,
};

/// Emit callback: Rust events → the frontend. Injected by the command layer.
pub type EmitFn = Arc<dyn Fn(RecorderEvent) + Send + Sync>;

/// Everything a finished recording produced. The command layer writes these into
/// a project directory (`cursor.json`, `meta.json`, `project.json`).
pub struct RecordingArtifacts {
    /// Absolute path to the finalized `screen.mp4` (kept for logging / Phase 4).
    #[allow(dead_code)]
    pub screen_path: PathBuf,
    pub cursor: CursorTrack,
    pub stats: CaptureStats,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

struct ActiveRecording {
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    join: JoinHandle<AppResult<RecordingArtifacts>>,
    #[allow(dead_code)]
    project_dir: PathBuf,
}

pub struct RecorderController {
    backend: Box<dyn CaptureBackend>,
    emit: EmitFn,
    state: Mutex<RecorderState>,
    active: Mutex<Option<ActiveRecording>>,
}

impl RecorderController {
    pub fn new(backend: Box<dyn CaptureBackend>, emit: EmitFn) -> Self {
        Self {
            backend,
            emit,
            state: Mutex::new(RecorderState::Idle),
            active: Mutex::new(None),
        }
    }

    // --- Backend passthroughs -------------------------------------------------

    #[allow(dead_code)] // surfaced via a command in Phase 4 onboarding.
    pub fn is_supported(&self) -> bool {
        self.backend.is_supported()
    }
    pub fn has_permission(&self) -> bool {
        self.backend.has_permission()
    }
    pub fn request_permission(&self) -> bool {
        self.backend.request_permission()
    }
    pub fn list_sources(&self) -> AppResult<Vec<CaptureSource>> {
        self.backend.list_sources()
    }

    pub fn list_devices(&self) -> AppResult<Vec<CaptureDevice>> {
        self.backend.list_devices()
    }

    pub fn state(&self) -> RecorderState {
        self.state.lock().clone()
    }

    fn set_state(&self, next: RecorderState) {
        *self.state.lock() = next.clone();
        (self.emit)(RecorderEvent::StateChanged { state: next });
    }

    // --- Lifecycle ------------------------------------------------------------

    /// Begin recording into `project_dir` (which must already exist). Writes the
    /// streaming video to `project_dir/screen.mp4`. Returns once the pipeline is
    /// live; the recording continues on background threads until [`Self::stop`].
    pub fn start(&self, config: &RecorderConfig, project_dir: &Path) -> AppResult<()> {
        {
            let state = self.state.lock();
            if state.is_active() {
                return Err(AppError::Busy(state.label().to_string()));
            }
        }

        // Bring up the capture source first — this is where permission / invalid
        // source errors surface, before we spawn anything.
        let capture: CaptureHandle = self.backend.start(config)?;
        let (width, height, fps) = (capture.width, capture.height, capture.fps);
        let system_audio = capture.audio.is_some();

        let screen_path = project_dir.join("screen.mp4");
        let encoder = Encoder::spawn(
            &screen_path,
            width,
            height,
            fps,
            config.quality,
            system_audio,
        )?;

        // One clock for everything: frame timestamps are measured from the
        // backend's `epoch`, so the cursor sampler must stamp against that
        // same instant. Starting the tracker on a fresh `Instant::now()` here
        // was the root cause of cursor drift — the two timelines disagreed by
        // the capture warm-up gap, and every zoom magnified the error.
        let t0 = capture.epoch;
        // iOS device capture records the phone screen — the Mac pointer has no
        // meaning on that timeline. The backend declares this via
        // `tracks_cursor`, so the controller never has to know which `source_id`
        // prefixes are device-shaped (that lives in the router).
        let cursor = if capture.tracks_cursor {
            CursorTracker::start(capture.capture_rect, capture.scale_factor, t0)
        } else {
            CursorTracker::disabled(capture.capture_rect, capture.scale_factor)
        };

        let stop_flag = Arc::new(AtomicBool::new(false));
        let pause_flag = Arc::new(AtomicBool::new(false));
        let emit = self.emit.clone();

        let join = spawn_encode_loop(
            capture,
            encoder,
            cursor,
            t0,
            stop_flag.clone(),
            pause_flag.clone(),
            emit,
            (width, height, fps),
            screen_path.clone(),
        );

        *self.active.lock() = Some(ActiveRecording {
            stop_flag,
            pause_flag,
            join,
            project_dir: project_dir.to_path_buf(),
        });
        self.set_state(RecorderState::Recording);
        Ok(())
    }

    pub fn pause(&self) -> AppResult<()> {
        let guard = self.active.lock();
        let active = guard.as_ref().ok_or(AppError::NotRecording)?;
        active.pause_flag.store(true, Ordering::Relaxed);
        drop(guard);
        self.set_state(RecorderState::Paused);
        Ok(())
    }

    pub fn resume(&self) -> AppResult<()> {
        let guard = self.active.lock();
        let active = guard.as_ref().ok_or(AppError::NotRecording)?;
        active.pause_flag.store(false, Ordering::Relaxed);
        drop(guard);
        self.set_state(RecorderState::Recording);
        Ok(())
    }

    /// Stop recording, finalize the MP4, and return the artifacts. The caller
    /// persists them into the project. On success the controller returns to Idle.
    pub fn stop(&self) -> AppResult<RecordingArtifacts> {
        let active = self.active.lock().take().ok_or(AppError::NotRecording)?;
        self.set_state(RecorderState::Finalizing);

        active.stop_flag.store(true, Ordering::Relaxed);
        let result = active
            .join
            .join()
            .map_err(|_| AppError::Encoder("recording thread panicked".into()))?;

        match result {
            Ok(artifacts) => {
                self.set_state(RecorderState::Idle);
                Ok(artifacts)
            }
            Err(e) => {
                self.set_state(RecorderState::Error {
                    message: e.to_string(),
                    fatal: true,
                });
                (self.emit)(RecorderEvent::Error {
                    message: e.to_string(),
                    fatal: true,
                });
                Err(e)
            }
        }
    }
}

/// The encode loop: pull frames from the bounded channel, write them through the
/// encoder, emit `Elapsed`, and on stop halt producers immediately then drain.
/// Runs on its own thread.
#[allow(clippy::too_many_arguments)]
fn spawn_encode_loop(
    mut capture: CaptureHandle,
    mut encoder: Encoder,
    cursor: CursorTracker,
    t0: Instant,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    emit: EmitFn,
    dims: (u32, u32, u32),
    screen_path: PathBuf,
) -> JoinHandle<AppResult<RecordingArtifacts>> {
    // Clone before the encode closure moves `screen_path` (error path needs it too).
    let screen_path_for_err = screen_path.clone();
    let thumb_path = screen_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(crate::project::thumbnail::THUMBNAIL_FILE);

    std::thread::Builder::new()
        .name("recorder-encode".into())
        .spawn(move || {
            let (width, height, fps) = dims;
            let mut frames_encoded: u64 = 0;
            let mut last_emit = Instant::now();
            // Poster after ~0.4s of *encoded* content (warm-up blacks are skipped).
            let thumb_at = ((fps as u64 * 2) / 5).max(1);
            let mut thumb_written = false;

            // Pace the encoder off real timestamps so dropped frames don't speed
            // the video up and drift from audio. `paused_accum` removes paused
            // spans from the timeline (audio is skipped during pause too, so both
            // stay aligned); `pause_mark` records where the current pause began.
            // `pause_spans` keeps the raw (start, end) pairs so the cursor track
            // can be folded onto the exact same pause-free timeline at the end.
            let mut pacer = FramePacer::new(fps);
            let mut paused_accum = 0.0f64;
            let mut pause_mark: Option<f64> = None;
            let mut pause_spans: Vec<(f64, f64)> = Vec::new();
            // Active-time of the first kept frame → timeline zero. Cursor/audio
            // share this epoch so export doesn't open on SCK warm-up black.
            let mut media_epoch: Option<f64> = None;

            loop {
                // Only mux audio once video has started — keeps A/V aligned with
                // the warm-up skip below.
                drain_audio(
                    &capture.audio,
                    &pause_flag,
                    &mut encoder,
                    media_epoch.is_some(),
                )?;

                let video_done = match capture.frames.recv_timeout(Duration::from_millis(100)) {
                    Ok(frame) => {
                        let ts = frame.timestamp.as_secs_f64();
                        if pause_flag.load(Ordering::Relaxed) {
                            // Mark where the pause began; hold everything until resume.
                            pause_mark.get_or_insert(ts);
                        } else {
                            // Resuming: fold the paused span out of the timeline.
                            if let Some(mark) = pause_mark.take() {
                                paused_accum += (ts - mark).max(0.0);
                                pause_spans.push((mark, ts.max(mark)));
                            }
                            let active_ts = ts - paused_accum;
                            let bytes_per_row = frame.bytes_per_row;

                            if media_epoch.is_none()
                                && !(active_ts < CAPTURE_WARMUP_MAX_SECS
                                    && is_capture_warmup_black(
                                        &frame.data,
                                        width,
                                        height,
                                        bytes_per_row,
                                    ))
                            {
                                media_epoch = Some(active_ts);
                            }

                            if let Some(epoch) = media_epoch {
                                let timeline_ts = (active_ts - epoch).max(0.0);
                                frames_encoded += pacer.push(
                                    &mut encoder,
                                    frame.data,
                                    bytes_per_row,
                                    timeline_ts,
                                )?;
                                // Poster grab reads the frame the pacer just retained
                                // (identical bytes to the one pushed) — no separate copy.
                                if !thumb_written && frames_encoded >= thumb_at {
                                    if let Some((data, bpr)) = pacer.last_frame() {
                                        if let Err(e) = crate::project::thumbnail::write_from_bgra(
                                            &thumb_path,
                                            width,
                                            height,
                                            bpr,
                                            data,
                                        ) {
                                            tracing::warn!(%e, "failed to write recording thumbnail");
                                        } else {
                                            thumb_written = true;
                                        }
                                    }
                                }
                            }
                        }
                        false
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => false,
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => true,
                };

                if last_emit.elapsed() >= Duration::from_millis(250) {
                    emit(RecorderEvent::Elapsed {
                        seconds: t0.elapsed().as_secs_f64(),
                    });
                    last_emit = Instant::now();
                }

                // Stop as soon as asked — do not keep the SCK producer alive
                // until the queue drains (that extended capture past Stop and
                // could encode post-stop screen content). Drain happens below
                // after `capture.stop()`.
                if stop_flag.load(Ordering::Relaxed) || video_done {
                    break;
                }
            }

            // Stop producers, then drain whatever is left in the channels.
            capture.stop();
            drain_audio(
                &capture.audio,
                &pause_flag,
                &mut encoder,
                media_epoch.is_some(),
            )?;
            while let Ok(frame) = capture.frames.try_recv() {
                if !pause_flag.load(Ordering::Relaxed) {
                    let ts = frame.timestamp.as_secs_f64();
                    if let Some(mark) = pause_mark.take() {
                        paused_accum += (ts - mark).max(0.0);
                        pause_spans.push((mark, ts.max(mark)));
                    }
                    let active_ts = ts - paused_accum;
                    let bytes_per_row = frame.bytes_per_row;
                    if media_epoch.is_none() {
                        if active_ts < CAPTURE_WARMUP_MAX_SECS
                            && is_capture_warmup_black(
                                &frame.data,
                                width,
                                height,
                                bytes_per_row,
                            )
                        {
                            continue;
                        }
                        media_epoch = Some(active_ts);
                    }
                    let timeline_ts = (active_ts - media_epoch.unwrap()).max(0.0);
                    frames_encoded +=
                        pacer.push(&mut encoder, frame.data, bytes_per_row, timeline_ts)?;
                }
            }

            // Recording ended while paused: everything from the pause start on
            // is off the video timeline, cursor samples included.
            if let Some(mark) = pause_mark.take() {
                pause_spans.push((mark, f64::INFINITY));
            }

            let frames_dropped = capture.dropped.load(Ordering::Relaxed);
            drop(capture);
            let finished_path = encoder.finish()?;
            let lead_in = media_epoch.unwrap_or(0.0);
            // Pause-fold first (spans are in shared-epoch time, like the video's
            // `paused_accum`), then shift onto the warm-up-trimmed timeline.
            let cursor_track =
                shift_cursor_track(fold_out_pauses(cursor.stop(), &pause_spans), lead_in);

            // Ultra-short clips: poster grab is best-effort — don't block editor open.
            if !thumb_written {
                let thumb_path = thumb_path.clone();
                let finished_path = finished_path.clone();
                std::thread::spawn(move || {
                    if let Err(e) =
                        crate::project::thumbnail::extract_from_mp4(&finished_path, &thumb_path)
                    {
                        tracing::warn!(%e, "fallback thumbnail extract failed");
                    }
                });
            }

            let stats = CaptureStats {
                frames_encoded,
                frames_dropped,
                // Encoded timeline length (excludes warm-up + paused wall time).
                duration_seconds: frames_encoded as f64 / fps.max(1) as f64,
            };

            Ok(RecordingArtifacts {
                screen_path: finished_path,
                cursor: cursor_track,
                stats,
                width,
                height,
                fps,
            })
        })
        .unwrap_or_else(|_| {
            // Spawning the encode thread should never fail; if it does, surface a
            // thread that immediately reports the error.
            std::thread::spawn(move || {
                Err(AppError::Encoder(format!(
                    "failed to spawn encode thread for {}",
                    screen_path_for_err.display()
                )))
            })
        })
}

/// Drain pending PCM. When `accept` is false, discard chunks so the queue
/// does not stall during capture warm-up before the first kept video frame.
fn drain_audio(
    audio: &Option<crossbeam_channel::Receiver<RawAudio>>,
    pause_flag: &AtomicBool,
    encoder: &mut Encoder,
    accept: bool,
) -> AppResult<()> {
    let Some(audio_rx) = audio else {
        return Ok(());
    };
    while let Ok(chunk) = audio_rx.try_recv() {
        if accept && !pause_flag.load(Ordering::Relaxed) {
            encoder.write_audio(&chunk.data, chunk.sample_rate, chunk.channels)?;
        }
    }
    Ok(())
}

/// ScreenCaptureKit (and similar) often emit near-black frames before the
/// desktop image is live. Encoding those as timeline t=0 makes preview/export
/// open on a black recording with only the cursor overlay.
///
/// Cheap grid sample — not a full-frame scan on the encode thread.
fn is_capture_warmup_black(bgra: &[u8], width: u32, height: u32, bytes_per_row: u32) -> bool {
    const STEP: usize = 16;
    const THRESH: u8 = 18;
    let stride = bytes_per_row as usize;
    let w = width as usize;
    let h = height as usize;
    if w == 0 || h == 0 || stride < w * 4 {
        return true;
    }
    let mut dark = 0usize;
    let mut total = 0usize;
    for y in (0..h).step_by(STEP) {
        let row = y * stride;
        for x in (0..w).step_by(STEP) {
            let i = row + x * 4;
            if i + 2 >= bgra.len() {
                continue;
            }
            total += 1;
            // BGRA
            if bgra[i] <= THRESH && bgra[i + 1] <= THRESH && bgra[i + 2] <= THRESH {
                dark += 1;
            }
        }
    }
    // ≥98% of samples near black → treat as warm-up.
    total > 0 && dark.saturating_mul(50) >= total.saturating_mul(49)
}

/// Max active-recording seconds we will wait for a non-black frame before
/// forcing the timeline to start (dark fullscreen apps must still record).
const CAPTURE_WARMUP_MAX_SECS: f64 = 0.75;

/// Remove paused wall-time spans from the cursor track, mirroring exactly how
/// the encode loop folds them out of the video timeline (`paused_accum`).
/// Samples inside a span are dropped; samples after it slide back by the
/// span's length. Spans are ascending and non-overlapping by construction.
fn fold_out_pauses(
    mut track: crate::cursor::CursorTrack,
    spans: &[(f64, f64)],
) -> crate::cursor::CursorTrack {
    if spans.is_empty() {
        return track;
    }
    track.samples.retain_mut(|s| {
        let mut removed = 0.0;
        for &(start, end) in spans {
            if s.t < start {
                break;
            }
            if s.t <= end {
                return false; // recorded during the pause — off the timeline
            }
            removed += end - start;
        }
        s.t -= removed;
        true
    });
    track
}

/// Shift cursor samples onto the video timeline after dropping warm-up frames.
fn shift_cursor_track(mut track: crate::cursor::CursorTrack, lead_in: f64) -> crate::cursor::CursorTrack {
    if lead_in <= 1e-6 {
        return track;
    }
    track.samples.retain_mut(|s| {
        s.t -= lead_in;
        s.t >= 0.0
    });
    track
}

/// How one captured frame maps onto the constant-`fps` output timeline.
struct FramePlan {
    /// Times to repeat the previous frame before this one, to fill the gap left
    /// by dropped frames.
    repeats: u64,
    /// False when the frame lands in an already-filled slot (duplicate cadence).
    write_current: bool,
    /// The next unfilled slot after applying this plan.
    next_index: u64,
}

/// Map a frame presented at `ts_secs` of *active* recording time onto a CFR
/// `fps` timeline given the next unfilled slot. FFmpeg treats the raw pipe as
/// constant-rate, so to keep the encoded duration matching wall-clock (and thus
/// the separately-muxed audio), we repeat the previous frame across gaps rather
/// than letting drops silently speed the video up. `max_fill` caps repeats so a
/// single glitched timestamp can't emit thousands of frames.
fn plan_frame(ts_secs: f64, fps: u32, next_index: u64, max_fill: u64) -> FramePlan {
    let target = (ts_secs * fps as f64).round().max(0.0) as u64;
    if target < next_index {
        // Two captures fell in the same slot → drop this one (but keep it as the
        // freshest "previous" frame for any later repeats).
        return FramePlan {
            repeats: 0,
            write_current: false,
            next_index,
        };
    }
    FramePlan {
        repeats: (target - next_index).min(max_fill),
        write_current: true,
        next_index: target + 1,
    }
}

/// Drives the encoder at a steady cadence off real frame timestamps, holding the
/// last frame to bridge dropped-frame gaps. Retains that frame by *moving* the
/// capture buffer in — no per-frame copy (a 4K BGRA frame is ~33 MB, so copying
/// one every tick would burn ~2 GB/s of bandwidth on the encode thread for a
/// buffer that's only read on the rare drop).
struct FramePacer {
    fps: u32,
    max_fill: u64,
    next_index: u64,
    last: Option<(Vec<u8>, u32)>,
}

impl FramePacer {
    fn new(fps: u32) -> Self {
        let fps = fps.max(1);
        Self {
            fps,
            max_fill: (fps as u64) * 5,
            next_index: 0,
            last: None,
        }
    }

    /// Encode the frame captured at `ts_secs` (active-recording seconds), first
    /// repeating the previous frame as needed to bridge dropped-frame gaps.
    /// Takes ownership of `data` and retains it as the new "previous" frame, so
    /// every pushed frame is available for a later repeat with no copy. Returns
    /// the number of output frames written.
    fn push(
        &mut self,
        encoder: &mut Encoder,
        data: Vec<u8>,
        bytes_per_row: u32,
        ts_secs: f64,
    ) -> AppResult<u64> {
        let plan = plan_frame(ts_secs, self.fps, self.next_index, self.max_fill);
        let mut written = 0u64;

        if plan.repeats > 0 {
            if let Some((last_data, last_bpr)) = &self.last {
                for _ in 0..plan.repeats {
                    encoder.write_frame(last_data, *last_bpr)?;
                    written += 1;
                }
            }
        }

        if plan.write_current {
            encoder.write_frame(&data, bytes_per_row)?;
            written += 1;
            self.next_index = plan.next_index;
        }

        self.remember(data, bytes_per_row);
        Ok(written)
    }

    /// Retain `data` as the frame to repeat across future gaps. An ownership
    /// move, not a copy: the buffer arrived fresh from the capture backend and
    /// would otherwise be dropped at the end of this tick.
    fn remember(&mut self, data: Vec<u8>, bytes_per_row: u32) {
        self.last = Some((data, bytes_per_row));
    }

    /// The most recently pushed frame's bytes + stride, for best-effort poster
    /// capture. `None` until the first `push`.
    fn last_frame(&self) -> Option<(&[u8], u32)> {
        self.last.as_ref().map(|(data, bpr)| (data.as_slice(), *bpr))
    }
}

#[cfg(test)]
mod tests {
    use super::backend::TestPatternBackend;
    use super::types::{QualityPreset, RecorderConfig};
    use super::*;

    fn silent_emit() -> EmitFn {
        Arc::new(|_ev| {})
    }

    #[test]
    fn pacing_writes_first_frame_without_repeats() {
        let p = plan_frame(0.0, 30, 0, 150);
        assert_eq!((p.repeats, p.write_current, p.next_index), (0, true, 1));
    }

    #[test]
    fn warmup_black_detects_near_black_bgra() {
        let w = 64u32;
        let h = 64u32;
        let stride = w * 4;
        let mut buf = vec![8u8; (stride * h) as usize];
        // Opaque alpha
        for px in buf.chunks_exact_mut(4) {
            px[3] = 255;
        }
        assert!(is_capture_warmup_black(&buf, w, h, stride));

        // Bright pixel in the grid → not warm-up.
        let i = (16 * stride + 16 * 4) as usize;
        buf[i] = 200;
        buf[i + 1] = 200;
        buf[i + 2] = 200;
        assert!(!is_capture_warmup_black(&buf, w, h, stride));
    }

    #[test]
    fn pause_folding_drops_and_slides_cursor_samples() {
        use crate::cursor::{CaptureRect, CursorKind, CursorSample, CursorTrack};
        let sample = |t: f64| CursorSample {
            t,
            x: 0.0,
            y: 0.0,
            kind: CursorKind::Move,
            shape: Default::default(),
        };
        let track = CursorTrack {
            capture_rect: CaptureRect::default(),
            scale_factor: 2.0,
            samples: vec![sample(0.5), sample(1.5), sample(2.5), sample(4.0)],
        };
        // Pause 1.0–2.0, and recording stopped during a second pause at 3.0.
        let folded = fold_out_pauses(track, &[(1.0, 2.0), (3.0, f64::INFINITY)]);
        let ts: Vec<f64> = folded.samples.iter().map(|s| s.t).collect();
        assert_eq!(ts.len(), 2);
        assert!((ts[0] - 0.5).abs() < 1e-9); // before any pause — untouched
        assert!((ts[1] - 1.5).abs() < 1e-9); // 2.5 minus the 1.0s pause
    }

    #[test]
    fn shift_cursor_drops_pre_epoch_samples() {
        use crate::cursor::{CaptureRect, CursorKind, CursorSample, CursorTrack};
        let track = CursorTrack {
            capture_rect: CaptureRect::default(),
            scale_factor: 2.0,
            samples: vec![
                CursorSample {
                    t: 0.1,
                    x: 0.0,
                    y: 0.0,
                    kind: CursorKind::Move,
                    shape: Default::default(),
                },
                CursorSample {
                    t: 0.5,
                    x: 0.5,
                    y: 0.5,
                    kind: CursorKind::Move,
                    shape: Default::default(),
                },
            ],
        };
        let shifted = shift_cursor_track(track, 0.4);
        assert_eq!(shifted.samples.len(), 1);
        assert!((shifted.samples[0].t - 0.1).abs() < 1e-9);
    }

    #[test]
    fn pacing_fills_dropped_frame_gaps_with_repeats() {
        // Next frame arrives ~3 slots in (2 frames were dropped at 30fps).
        let p = plan_frame(0.1, 30, 1, 150);
        assert_eq!((p.repeats, p.write_current, p.next_index), (2, true, 4));
    }

    #[test]
    fn pacing_decimates_when_capture_outpaces_fps() {
        // 60fps capture into a 30fps timeline: every other frame is a duplicate slot.
        let a = plan_frame(1.0 / 60.0, 30, 1, 150); // → slot 1, advances
        assert!(a.write_current && a.next_index == 2);
        let b = plan_frame(2.0 / 60.0, 30, 2, 150); // → maps back to slot 1, drop
        assert!(!b.write_current && b.repeats == 0 && b.next_index == 2);
    }

    #[test]
    fn pacing_caps_repeats_against_glitched_timestamps() {
        let p = plan_frame(10_000.0, 30, 0, 150);
        assert_eq!(p.repeats, 150);
        assert!(p.write_current);
    }

    #[test]
    fn pacer_retains_latest_frame_for_gap_fill() {
        // `remember` moves the buffer in (no copy) and `last_frame` exposes it —
        // this is the frame `push` repeats across dropped-frame gaps.
        let mut pacer = FramePacer::new(30);
        assert!(pacer.last_frame().is_none());

        pacer.remember(vec![1, 2, 3, 4], 8);
        assert_eq!(pacer.last_frame(), Some(([1u8, 2, 3, 4].as_slice(), 8)));

        // Latest capture wins — gap-fill repeats the freshest retained frame.
        pacer.remember(vec![9, 9], 4);
        assert_eq!(pacer.last_frame(), Some(([9u8, 9].as_slice(), 4)));
    }

    #[test]
    fn records_a_short_clip_into_a_valid_mp4() {
        // Skip gracefully if ffmpeg isn't available on the test machine.
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
        {
            eprintln!("ffmpeg not found — skipping encode test");
            return;
        }

        let dir = std::env::temp_dir().join(format!("capptivo-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let backend = Box::new(TestPatternBackend {
            max_frames: Some(30),
        });
        let controller = RecorderController::new(backend, silent_emit());

        let config = RecorderConfig {
            source_id: "display:test".into(),
            crop: None,
            fps: 30,
            show_cursor: true,
            capture_system_audio: false,
            capture_microphone: false,
            quality: QualityPreset::Balanced,
        };

        controller.start(&config, &dir).unwrap();
        assert_eq!(controller.state(), RecorderState::Recording);
        // Let the 30 synthetic frames flow.
        std::thread::sleep(Duration::from_millis(700));
        let artifacts = controller.stop().unwrap();

        assert_eq!(controller.state(), RecorderState::Idle);
        assert!(artifacts.screen_path.exists());
        let size = std::fs::metadata(&artifacts.screen_path).unwrap().len();
        assert!(size > 0, "screen.mp4 should be non-empty");
        assert!(artifacts.stats.frames_encoded > 0);

        std::fs::remove_dir_all(&dir).ok();
    }
}

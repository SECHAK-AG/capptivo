//! The recorder controller: the state machine that owns the capture → encode →
//! cursor pipeline. It is **Tauri-free** (per §14) so it can be unit-tested with
//! the synthetic backend; the `commands` layer injects the event `emit` closure
//! and the project directory, and finalizes the returned artifacts into a project.

pub mod area_crop;
pub mod backend;
pub mod encoder;
pub mod hw_encoder;
pub mod mic_devices;
pub mod mic_warm;
pub mod types;

pub use mic_warm::{cool_microphone, warm_microphone};

use crate::cursor::{CursorTrack, CursorTracker};
use crate::error::{AppError, AppResult};
use backend::{CaptureBackend, CaptureHandle, RawAudio};
use encoder::Encoder;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
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
    /// Set when the encode loop hit an error but still salvaged a partial take.
    pub error: Option<AppError>,
    /// Capture ended because the producer disconnected before the user stopped.
    pub interrupted: bool,
    /// Milliseconds from **encoded** timeline t=0 to the face-cam's first sample.
    /// `None` when no face-cam was recorded.
    pub camera_offset_ms: Option<i64>,
    /// Capture-epoch seconds trimmed as warm-up before encoded t=0.
    pub media_lead_in_ms: i64,
}

struct ActiveRecording {
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    /// When true, native mic PCM is discarded (session mute).
    mic_mute: Arc<AtomicBool>,
    join: JoinHandle<AppResult<RecordingArtifacts>>,
    #[allow(dead_code)]
    project_dir: PathBuf,
    /// Capture clock (`CaptureHandle::epoch`).
    epoch: Instant,
    /// Milliseconds from `epoch` to the face-cam recorder's first sample, or
    /// [`CAMERA_OFFSET_UNSET`] until the bubble reports in.
    camera_offset_ms: Arc<AtomicI64>,
}

/// Sentinel for "the face-cam never started". Real offsets are ≥ 0 when the
/// cam starts after the screen, but 0 is a valid tiny gap.
const CAMERA_OFFSET_UNSET: i64 = i64::MIN;

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
    pub fn list_sources(&self, include_thumbnails: bool) -> AppResult<Vec<CaptureSource>> {
        self.backend.list_sources(include_thumbnails)
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
        let (width, height) = encodable_dimensions(capture.width, capture.height)?;
        let mut notices: Vec<String> = capture.notice.iter().cloned().collect();
        let fps = capture.fps;
        let system_audio = capture.audio.is_some();
        let microphone = capture.mic.is_some();

        let screen_path = project_dir.join("screen.mp4");
        let encoder = Encoder::spawn(
            &screen_path,
            width,
            height,
            fps,
            config.quality,
            system_audio,
            microphone,
        )?;
        notices.extend(encoder.software_fallback_notice());

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
        let mic_mute = Arc::new(AtomicBool::new(false));
        let camera_offset_ms = Arc::new(AtomicI64::new(CAMERA_OFFSET_UNSET));
        let media_lead_in_ms = Arc::new(AtomicI64::new(0));
        let emit = self.emit.clone();

        let join = spawn_encode_loop(
            capture,
            encoder,
            cursor,
            t0,
            stop_flag.clone(),
            pause_flag.clone(),
            mic_mute.clone(),
            media_lead_in_ms.clone(),
            emit,
            (width, height, fps),
            screen_path.clone(),
        );

        *self.active.lock() = Some(ActiveRecording {
            stop_flag,
            pause_flag,
            mic_mute,
            join,
            project_dir: project_dir.to_path_buf(),
            epoch: t0,
            camera_offset_ms,
        });
        self.set_state(RecorderState::Recording);
        (self.emit)(RecorderEvent::Elapsed { seconds: 0.0 });
        // Non-fatal: the recorder shows it as a toast and keeps the take going.
        // Emitted after the state change so a listener that resets on
        // `StateChanged` does not wipe it.
        for message in notices {
            tracing::info!(%message, "capture notice");
            (self.emit)(RecorderEvent::Error {
                message,
                fatal: false,
            });
        }
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

    /// Mute/unmute native mic PCM without tearing down the capture session.
    pub fn set_mic_muted(&self, muted: bool) -> AppResult<()> {
        let guard = self.active.lock();
        let active = guard.as_ref().ok_or(AppError::NotRecording)?;
        active.mic_mute.store(muted, Ordering::Relaxed);
        Ok(())
    }

    /// Offset = cameraStart − captureEpoch.
    /// Call only after [`Self::start`] — face-cam begins once the screen is live.
    /// At stop, warm-up blacks trimmed from the MP4 are subtracted so the editor
    /// offset is relative to encoded t=0.
    pub fn mark_camera_started(&self) -> AppResult<i64> {
        let guard = self.active.lock();
        let active = guard.as_ref().ok_or(AppError::NotRecording)?;
        let offset_ms = instant_offset_ms(active.epoch, Instant::now());
        let _ = active.camera_offset_ms.compare_exchange(
            CAMERA_OFFSET_UNSET,
            offset_ms,
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
        Ok(active.camera_offset_ms.load(Ordering::Relaxed))
    }

    /// Stop recording, finalize the MP4, and return the artifacts. The caller
    /// persists them into the project. On success the controller returns to Idle.
    pub fn stop(&self) -> AppResult<RecordingArtifacts> {
        let active = self.active.lock().take().ok_or(AppError::NotRecording)?;
        self.set_state(RecorderState::Finalizing);

        active.stop_flag.store(true, Ordering::Relaxed);
        let raw_camera_offset = match active.camera_offset_ms.load(Ordering::Relaxed) {
            CAMERA_OFFSET_UNSET => None,
            ms => Some(ms),
        };
        let result = active
            .join
            .join()
            .map_err(|_| AppError::Encoder("recording thread panicked".into()))?;

        match result {
            Ok(mut artifacts) => {
                // Encoded t=0 skips capture warm-up blacks — rebase the wall offset.
                artifacts.camera_offset_ms = raw_camera_offset
                    .map(|ms| ms.saturating_sub(artifacts.media_lead_in_ms));
                if let Some(ref e) = artifacts.error {
                    let message = e.to_string();
                    self.set_state(RecorderState::Error {
                        message: message.clone(),
                        fatal: true,
                    });
                    (self.emit)(RecorderEvent::Error {
                        message,
                        fatal: true,
                    });
                } else if artifacts.interrupted {
                    self.set_state(RecorderState::Idle);
                } else {
                    self.set_state(RecorderState::Idle);
                }
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

fn instant_offset_ms(epoch: Instant, at: Instant) -> i64 {
    if at >= epoch {
        at.duration_since(epoch).as_millis() as i64
    } else {
        -(epoch.duration_since(at).as_millis() as i64)
    }
}

fn encodable_dimensions(width: u32, height: u32) -> AppResult<(u32, u32)> {
    let (even_width, even_height) = (width & !1, height & !1);
    if even_width == 0 || even_height == 0 {
        return Err(AppError::Other(format!(
            "capture source produced an unusable frame size ({width}x{height})"
        )));
    }
    Ok((even_width, even_height))
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
    mic_mute: Arc<AtomicBool>,
    media_lead_in_ms: Arc<AtomicI64>,
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
            // Only pooling backends get the recycle hook. Wiring it up
            // unconditionally would have the pacer park buffers no producer
            // ever reclaims — a retention, not a saving.
            let mut pacer = match &capture.pool {
                Some(pool) => FramePacer::new(fps).with_pool(pool.clone()),
                None => FramePacer::new(fps),
            };
            let mut paused_accum = 0.0f64;
            let mut pause_mark: Option<f64> = None;
            let mut pause_spans: Vec<(f64, f64)> = Vec::new();
            // Active-time of the first kept frame → timeline zero. Cursor/audio
            // share this epoch so export doesn't open on SCK warm-up black.
            let mut media_epoch: Option<f64> = None;
            // Wall-clock pause tracking for the HUD timer (independent of frame
            // timestamps). Without this, `Elapsed` kept advancing on Pause.
            let mut hud_pause_mark: Option<Instant> = None;
            let mut hud_paused_accum = Duration::ZERO;
            let mut encode_error: Option<AppError> = None;
            let mut interrupted = false;

            // Once encoding fails the take is over: this loop breaks, so no more
            // progress ticks are sent and the file stops growing. Without a signal
            // here the popover still looks like it is recording, and the user only
            // finds out when they press Stop. By then they have "recorded" minutes
            // into a file that never grew. Say so at the point of failure instead.
            let report_encode_failure = |e: &AppError| {
                tracing::error!(%e, "encoding failed mid-recording; ending the take");
                emit(RecorderEvent::Error {
                    message: e.to_string(),
                    fatal: true,
                });
            };

            loop {
                if encode_error.is_none() {
                    if let Err(e) = drain_audio(
                        &capture.audio,
                        &pause_flag,
                        &mut encoder,
                        media_epoch,
                        paused_accum,
                    ) {
                        report_encode_failure(&e);
                        encode_error = Some(e);
                        break;
                    }
                    if let Err(e) = drain_mic(
                        &capture.mic,
                        &pause_flag,
                        &mic_mute,
                        &mut encoder,
                        media_epoch,
                        paused_accum,
                    ) {
                        report_encode_failure(&e);
                        encode_error = Some(e);
                        break;
                    }
                }

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
                                media_lead_in_ms.store(
                                    (active_ts.max(0.0) * 1000.0).round() as i64,
                                    Ordering::Relaxed,
                                );
                            }

                            if let Some(epoch) = media_epoch {
                                let timeline_ts = (active_ts - epoch).max(0.0);
                                match pacer.push(
                                    &mut encoder,
                                    frame.data,
                                    bytes_per_row,
                                    timeline_ts,
                                ) {
                                    Ok(n) => frames_encoded += n,
                                    Err(e) => {
                                        report_encode_failure(&e);
                                        encode_error = Some(e);
                                        break;
                                    }
                                }
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
                    if pause_flag.load(Ordering::Relaxed) {
                        hud_pause_mark.get_or_insert_with(Instant::now);
                    } else if let Some(mark) = hud_pause_mark.take() {
                        hud_paused_accum += mark.elapsed();
                    }
                    let paused_now = hud_pause_mark
                        .map(|m| m.elapsed())
                        .unwrap_or(Duration::ZERO);
                    let seconds = hud_elapsed_secs(
                        t0.elapsed(),
                        hud_paused_accum,
                        paused_now,
                    );
                    emit(RecorderEvent::Elapsed { seconds });
                    last_emit = Instant::now();
                }

                // Stop as soon as asked — do not keep the SCK producer alive
                // until the queue drains (that extended capture past Stop and
                // could encode post-stop screen content). Drain happens below
                // after `capture.stop()`.
                if video_done && !stop_flag.load(Ordering::Relaxed) {
                    interrupted = true;
                    emit(RecorderEvent::Interrupted {
                        frames_encoded,
                    });
                    emit(RecorderEvent::StateChanged {
                        state: RecorderState::Idle,
                    });
                    break;
                }
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }
            }

            // Stop producers, then drain whatever is left in the channels.
            capture.stop();
            if encode_error.is_none() {
                if let Err(e) = drain_audio(
                    &capture.audio,
                    &pause_flag,
                    &mut encoder,
                    media_epoch,
                    paused_accum,
                ) {
                    encode_error = Some(e);
                }
            }
            if encode_error.is_none() {
                if let Err(e) = drain_mic(
                    &capture.mic,
                    &pause_flag,
                    &mic_mute,
                    &mut encoder,
                    media_epoch,
                    paused_accum,
                ) {
                    encode_error = Some(e);
                }
            }
            if encode_error.is_none() {
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
                            media_lead_in_ms.store(
                                (active_ts.max(0.0) * 1000.0).round() as i64,
                                Ordering::Relaxed,
                            );
                        }
                        let timeline_ts = (active_ts - media_epoch.unwrap()).max(0.0);
                        match pacer.push(&mut encoder, frame.data, bytes_per_row, timeline_ts)
                        {
                            Ok(n) => frames_encoded += n,
                            Err(e) => {
                                encode_error = Some(e);
                                break;
                            }
                        }
                    }
                }
            }

            // Recording ended while paused: everything from the pause start on
            // is off the video timeline, cursor samples included.
            if let Some(mark) = pause_mark.take() {
                pause_spans.push((mark, f64::INFINITY));
            }

            let frames_dropped = capture.dropped.load(Ordering::Relaxed);
            drop(capture);
            let finished_path = match encoder.finish() {
                Ok(path) => path,
                Err(e) => {
                    tracing::warn!(%e, "encoder.finish failed; keeping partial file");
                    screen_path.clone()
                }
            };
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
                error: encode_error,
                interrupted,
                // Owned by the controller — the bubble reports in over IPC while
                // this thread is busy encoding. `stop` fills it before returning.
                camera_offset_ms: None,
                media_lead_in_ms: media_lead_in_ms.load(Ordering::Relaxed),
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

/// Drain pending PCM onto the encoded timeline.
///
/// Chunks before `media_epoch` are dropped. Later chunks are placed at
/// `timestamp − media_epoch − paused_accum`, with silence padded so A/V share
/// one clock (capture PTS, not arrival order).
fn drain_audio(
    audio: &Option<crossbeam_channel::Receiver<RawAudio>>,
    pause_flag: &AtomicBool,
    encoder: &mut Encoder,
    media_epoch: Option<f64>,
    paused_accum: f64,
) -> AppResult<()> {
    let Some(audio_rx) = audio else {
        return Ok(());
    };
    let Some(epoch) = media_epoch else {
        while audio_rx.try_recv().is_ok() {}
        return Ok(());
    };
    while let Ok(chunk) = audio_rx.try_recv() {
        if pause_flag.load(Ordering::Relaxed) {
            continue;
        }
        let ts = chunk.timestamp.as_secs_f64();
        if ts + 1e-4 < epoch {
            continue;
        }
        let timeline = (ts - epoch - paused_accum).max(0.0);
        encoder.write_audio_at(timeline, &chunk.data, chunk.sample_rate, chunk.channels)?;
    }
    Ok(())
}

/// Same as [`drain_audio`] for the mic sidecar; muted sessions write silence so
/// the mic timeline stays aligned with video.
fn drain_mic(
    mic: &Option<crossbeam_channel::Receiver<RawAudio>>,
    pause_flag: &AtomicBool,
    mic_mute: &AtomicBool,
    encoder: &mut Encoder,
    media_epoch: Option<f64>,
    paused_accum: f64,
) -> AppResult<()> {
    let Some(mic_rx) = mic else {
        return Ok(());
    };
    let Some(epoch) = media_epoch else {
        while mic_rx.try_recv().is_ok() {}
        return Ok(());
    };
    while let Ok(chunk) = mic_rx.try_recv() {
        if pause_flag.load(Ordering::Relaxed) {
            continue;
        }
        let ts = chunk.timestamp.as_secs_f64();
        if ts + 1e-4 < epoch {
            continue;
        }
        let timeline = (ts - epoch - paused_accum).max(0.0);
        if mic_mute.load(Ordering::Relaxed) {
            let silence = vec![0u8; chunk.data.len()];
            encoder.write_mic_at(timeline, &silence, chunk.sample_rate, chunk.channels)?;
        } else {
            encoder.write_mic_at(timeline, &chunk.data, chunk.sample_rate, chunk.channels)?;
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

/// HUD timer: wall clock minus completed pauses minus the open pause (if any).
fn hud_elapsed_secs(
    wall: Duration,
    paused_accum: Duration,
    current_pause: Duration,
) -> f64 {
    wall.saturating_sub(paused_accum + current_pause)
        .as_secs_f64()
}

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

/// The CFR slot a frame presented at `ts_secs` of capture time belongs to.
///
/// Deliberately the same arithmetic as [`plan_frame`]'s `target`. The two must
/// agree on what a slot is — see [`capture_slot_gate`].
// Called only from the Windows capture backend. Elsewhere the tests below are
// its only caller, which `dead_code` analysis does not count.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn frame_slot(ts_secs: f64, fps: u32) -> u64 {
    (ts_secs * f64::from(fps.max(1))).round().max(0.0) as u64
}

/// [`plan_frame`]'s drop rule, hoisted so a *capture backend* can apply it
/// before paying to read a frame back off the GPU.
///
/// Returns the next unfilled slot when the frame opens a new one, or `None`
/// when its slot is already filled — the case [`plan_frame`] answers with
/// `write_current: false`. A backend that consults this drops exactly the
/// frames the encoder would have discarded anyway, so the encoded result is
/// unchanged; what it saves is the readback.
///
/// This lives next to [`plan_frame`] on purpose. The guarantee "the gate never
/// starves a slot the encoder wanted" holds only while both use the same slot
/// arithmetic, so the two functions must be edited together.
// Called only from the Windows capture backend — see `frame_slot`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn capture_slot_gate(ts_secs: f64, fps: u32, next_slot: u64) -> Option<u64> {
    let slot = frame_slot(ts_secs, fps);
    if slot < next_slot {
        None
    } else {
        Some(slot + 1)
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
    /// Where displaced frame buffers go to be reused by the producer. `None`
    /// for backends that don't pool, and in tests.
    pool: Option<crate::recorder::backend::FrameBufferPool>,
}

impl FramePacer {
    fn new(fps: u32) -> Self {
        let fps = fps.max(1);
        Self {
            fps,
            max_fill: (fps as u64) * 5,
            next_index: 0,
            last: None,
            pool: None,
        }
    }

    /// Return displaced buffers to `pool` so the capture producer can refill
    /// them instead of allocating. See `FrameBufferPool`.
    fn with_pool(mut self, pool: crate::recorder::backend::FrameBufferPool) -> Self {
        self.pool = Some(pool);
        self
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
        // The frame being displaced has already been written to the encoder
        // (`write_frame` copies into the pipe and flushes before returning), so
        // nothing references it any more and it is safe to recycle.
        if let (Some(pool), Some((old, _))) = (&self.pool, self.last.take()) {
            pool.put(old);
        }
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
    fn camera_offset_needs_an_active_recording() {
        let controller =
            RecorderController::new(Box::new(TestPatternBackend::default()), silent_emit());
        assert!(matches!(
            controller.mark_camera_started(),
            Err(AppError::NotRecording)
        ));
    }

    /// Offset = cameraStart − epoch; only the first stamp counts.
    #[test]
    fn camera_offset_is_measured_once_against_the_capture_epoch() {
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
        {
            eprintln!("ffmpeg not found — skipping camera offset test");
            return;
        }

        let dir = std::env::temp_dir().join(format!("capptivo-offset-{}", uuid::Uuid::new_v4()));
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
            microphone_device_id: None,
            microphone_label: None,
            quality: QualityPreset::Balanced,
        };
        controller.start(&config, &dir).unwrap();

        std::thread::sleep(Duration::from_millis(120));
        let first = controller.mark_camera_started().unwrap();
        assert!(
            (100..2_000).contains(&first),
            "offset should track the delay since the epoch, got {first}ms"
        );

        std::thread::sleep(Duration::from_millis(60));
        let second = controller.mark_camera_started().unwrap();
        assert_eq!(second, first, "the first report wins");

        let artifacts = controller.stop().unwrap();
        let expected = first.saturating_sub(artifacts.media_lead_in_ms);
        assert_eq!(artifacts.camera_offset_ms, Some(expected));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A take with no face-cam must not claim an offset — the editor reads
    /// `None` as "aligned", and a stray zero would be indistinguishable.
    #[test]
    fn no_face_cam_reports_no_offset() {
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
        {
            eprintln!("ffmpeg not found — skipping camera offset test");
            return;
        }

        let dir = std::env::temp_dir().join(format!("capptivo-nooffset-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let controller = RecorderController::new(
            Box::new(TestPatternBackend {
                max_frames: Some(30),
            }),
            silent_emit(),
        );
        let config = RecorderConfig {
            source_id: "display:test".into(),
            crop: None,
            fps: 30,
            show_cursor: true,
            capture_system_audio: false,
            capture_microphone: false,
            microphone_device_id: None,
            microphone_label: None,
            quality: QualityPreset::Balanced,
        };
        controller.start(&config, &dir).unwrap();
        std::thread::sleep(Duration::from_millis(80));
        let artifacts = controller.stop().unwrap();
        assert_eq!(artifacts.camera_offset_ms, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pacing_writes_first_frame_without_repeats() {
        let p = plan_frame(0.0, 30, 0, 150);
        assert_eq!((p.repeats, p.write_current, p.next_index), (0, true, 1));
    }

    #[test]
    fn odd_capture_sizes_are_trimmed_to_even() {
        // The real case: a VM guest display at 1512x949 — one row is dropped
        // instead of ffmpeg refusing to open the encoder.
        assert_eq!(encodable_dimensions(1512, 949).unwrap(), (1512, 948));
        assert_eq!(encodable_dimensions(1281, 723).unwrap(), (1280, 722));
        // Already even → untouched.
        assert_eq!(encodable_dimensions(1920, 1080).unwrap(), (1920, 1080));
    }

    #[test]
    fn degenerate_capture_sizes_are_rejected() {
        // Nothing encodable is left after the trim: fail at start with a clear
        // message rather than spawning ffmpeg against a 0-wide pipe.
        for (w, h) in [(0, 720), (1280, 0), (1, 720), (1280, 1)] {
            assert!(encodable_dimensions(w, h).is_err(), "{w}x{h} should be rejected");
        }
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
    fn hud_elapsed_freezes_during_pause() {
        let wall = Duration::from_secs(10);
        let prior = Duration::from_secs(2);
        let open = Duration::from_secs(3);
        // 10 − 2 − 3 = 5 while paused; resumes from the same 5.
        assert!((hud_elapsed_secs(wall, prior, open) - 5.0).abs() < 1e-9);
        assert!((hud_elapsed_secs(wall, prior, Duration::ZERO) - 8.0).abs() < 1e-9);
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
    fn capture_gate_admits_the_first_frame() {
        // The session's dimension rendezvous rides on the first frame — gating
        // it away would hang `start` on its 5s `meta_rx` timeout.
        assert_eq!(capture_slot_gate(0.0, 60, 0), Some(1));
    }

    #[test]
    fn capture_gate_passes_everything_when_arrivals_match_the_target() {
        // 60 Hz display, 60 fps target: nothing is surplus, so nothing is gated.
        let mut next = 0;
        let mut admitted = 0;
        for i in 0..60 {
            if let Some(n) = capture_slot_gate(f64::from(i) / 60.0, 60, next) {
                next = n;
                admitted += 1;
            }
        }
        assert_eq!(admitted, 60, "a 60 Hz arrival stream must pass untouched");
    }

    #[test]
    fn capture_gate_passes_everything_when_arrivals_are_slower_than_target() {
        // A mostly-static screen: WGC delivers on change, well under 60 fps.
        let mut next = 0;
        let mut admitted = 0;
        for i in 0..10 {
            if let Some(n) = capture_slot_gate(f64::from(i) / 8.0, 60, next) {
                next = n;
                admitted += 1;
            }
        }
        assert_eq!(admitted, 10, "the gate must never drop a frame the encoder wants");
    }

    #[test]
    fn capture_gate_decimates_high_refresh_arrivals_to_the_target_rate() {
        // The case this gate exists for: 144 Hz display, 60 fps encode.
        const SECONDS: u32 = 5;
        const HZ: u32 = 144;
        let mut next = 0;
        let mut admitted: u32 = 0;
        for i in 0..HZ * SECONDS {
            if let Some(n) = capture_slot_gate(f64::from(i) / f64::from(HZ), 60, next) {
                next = n;
                admitted += 1;
            }
        }
        // One readback per CFR slot: 60/s, ±1 for where the window's edges fall
        // relative to a slot centre. Never fewer, or the encoder would have to
        // repeat frames to fill slots the gate starved.
        let expected = 60 * SECONDS;
        assert!(
            admitted.abs_diff(expected) <= 1,
            "144 Hz in must yield ~{expected} readbacks over {SECONDS}s, got {admitted}"
        );
        // And the point of the exercise: most arrivals never reach the GPU.
        assert!(
            admitted < HZ * SECONDS / 2,
            "the gate must eliminate the majority of a 144 Hz stream"
        );
    }

    #[test]
    fn capture_gate_drops_exactly_what_plan_frame_would_have_dropped() {
        // The load-bearing invariant: the gate is `plan_frame`'s drop rule moved
        // to the producer. If these two ever disagree, the gate is either
        // wasting readbacks or starving the timeline.
        let mut gate_next = 0;
        let mut pacer_next = 0;
        for i in 0..500 {
            let ts = f64::from(i) / 165.0; // 165 Hz, an ordinary gaming monitor
            let gate = capture_slot_gate(ts, 60, gate_next);
            let plan = plan_frame(ts, 60, pacer_next, 300);
            assert_eq!(
                gate.is_some(),
                plan.write_current,
                "gate and plan_frame disagreed at frame {i} (t={ts})"
            );
            if let Some(n) = gate {
                gate_next = n;
            }
            pacer_next = plan.next_index;
        }
    }

    #[test]
    fn capture_gate_matches_plan_frame_through_a_timestamp_glitch() {
        // A single wild timestamp advances the slot cursor far ahead, which
        // suppresses everything until real time catches up. That is not a
        // regression the gate introduces: `plan_frame` reacts the same way, so
        // the affected frames were never going to be encoded. Proving the two
        // stay in lockstep here is what makes it safe to drop them earlier.
        let mut gate_next = 0;
        let mut pacer_next = 0;
        let feed: Vec<f64> = (0..30)
            .map(|i| f64::from(i) / 144.0)
            // The glitch, then a return to a normal cadence.
            .chain(std::iter::once(9_000.0))
            .chain((30..90).map(|i| f64::from(i) / 144.0))
            .collect();

        for (i, ts) in feed.into_iter().enumerate() {
            let gate = capture_slot_gate(ts, 60, gate_next);
            let plan = plan_frame(ts, 60, pacer_next, 300);
            assert_eq!(
                gate.is_some(),
                plan.write_current,
                "gate and plan_frame diverged at feed index {i} (t={ts})"
            );
            if let Some(n) = gate {
                gate_next = n;
            }
            pacer_next = plan.next_index;
        }
    }

    #[test]
    fn capture_gate_never_latches_shut() {
        // A frozen clock must not wedge the gate closed forever: once time
        // advances past the filled slot, frames flow again.
        let mut next = 0;
        next = capture_slot_gate(1.0, 60, next).expect("first frame admitted");
        assert!(capture_slot_gate(1.0, 60, next).is_none(), "same slot is surplus");
        assert!(capture_slot_gate(1.0, 60, next).is_none(), "still surplus");
        assert!(
            capture_slot_gate(1.0 + 1.0 / 60.0, 60, next).is_some(),
            "the next slot must reopen the gate"
        );
    }

    #[test]
    fn capture_gate_survives_a_zero_fps_argument() {
        // `fps` is clamped by the caller, but the function must stay total.
        assert!(capture_slot_gate(0.5, 0, 0).is_some());
    }

    #[test]
    fn pacing_caps_repeats_against_glitched_timestamps() {
        let p = plan_frame(10_000.0, 30, 0, 150);
        assert_eq!(p.repeats, 150);
        assert!(p.write_current);
    }

    #[test]
    fn pacer_returns_displaced_buffers_to_the_pool() {
        let pool = crate::recorder::backend::FrameBufferPool::new();
        let mut pacer = FramePacer::new(30).with_pool(pool.clone());

        pacer.remember(vec![1u8; 16], 4);
        assert_eq!(pool.len(), 0, "the first frame is still held for gap-fill");

        pacer.remember(vec![2u8; 16], 4);
        assert_eq!(pool.len(), 1, "the displaced frame must come back for reuse");

        // And the retained frame is the new one, not the recycled one.
        assert_eq!(pacer.last_frame().map(|(d, _)| d[0]), Some(2));
    }

    #[test]
    fn pacer_without_a_pool_still_works() {
        // Non-Windows backends construct the pacer with no pool; displaced
        // buffers are simply freed as before.
        let mut pacer = FramePacer::new(30);
        pacer.remember(vec![1u8; 8], 4);
        pacer.remember(vec![2u8; 8], 4);
        assert_eq!(pacer.last_frame().map(|(d, _)| d[0]), Some(2));
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
            microphone_device_id: None,
            microphone_label: None,
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
        assert!(artifacts.error.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stop_returns_idle_after_successful_clip() {
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
            max_frames: Some(10),
        });
        let controller = RecorderController::new(backend, silent_emit());

        let config = RecorderConfig {
            source_id: "display:test".into(),
            crop: None,
            fps: 30,
            show_cursor: true,
            capture_system_audio: false,
            capture_microphone: false,
            microphone_device_id: None,
            microphone_label: None,
            quality: QualityPreset::Balanced,
        };

        controller.start(&config, &dir).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let artifacts = controller.stop().unwrap();
        assert!(artifacts.error.is_none());
        assert_eq!(controller.state(), RecorderState::Idle);

        // A second recording must not be blocked by a wedged session.
        controller.start(&config, &dir).unwrap();
        assert_eq!(controller.state(), RecorderState::Recording);
        let _ = controller.stop().unwrap();
        assert_eq!(controller.state(), RecorderState::Idle);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Losing the encoder mid-take has to announce itself. It used to break the
    /// loop silently: progress ticks stopped, the popover still looked like it was
    /// recording, and the user only found out when they pressed Stop, by which
    /// point they had "recorded" minutes into a file that stopped growing.
    #[cfg(unix)]
    #[test]
    fn losing_the_encoder_mid_take_is_reported_without_waiting_for_stop() {
        if std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_err()
        {
            eprintln!("ffmpeg not found, skipping encoder failure test");
            return;
        }

        // The tag lands in the encoder's output path, so `pkill -f` hits this
        // test's child and nothing else on the machine.
        let tag = format!("capptivo-encoder-loss-{}", uuid::Uuid::new_v4());
        let dir = std::env::temp_dir().join(&tag);
        std::fs::create_dir_all(&dir).unwrap();

        let reported = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = reported.clone();
        let emit: EmitFn = Arc::new(move |ev| {
            if let RecorderEvent::Error { message, .. } = ev {
                sink.lock().unwrap().push(message);
            }
        });

        let controller =
            RecorderController::new(Box::new(TestPatternBackend::default()), emit);
        let config = RecorderConfig {
            source_id: "display:test".into(),
            crop: None,
            fps: 30,
            show_cursor: true,
            capture_system_audio: false,
            capture_microphone: false,
            microphone_device_id: None,
            microphone_label: None,
            quality: QualityPreset::Balanced,
        };
        controller.start(&config, &dir).unwrap();

        // Let the encode loop settle, then kill the encoder out from under it.
        std::thread::sleep(Duration::from_millis(500));
        let _ = std::process::Command::new("pkill")
            .args(["-f", &tag])
            .output();

        // Nobody calls stop() here. The report has to arrive on its own.
        let deadline = Instant::now() + Duration::from_secs(10);
        while reported.lock().unwrap().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let seen = reported.lock().unwrap().clone();

        let _ = controller.stop();
        std::fs::remove_dir_all(&dir).ok();

        assert!(
            !seen.is_empty(),
            "losing the encoder must emit RecorderEvent::Error while the take is \
             still live, so the popover can stop claiming to record"
        );
    }
}

//! System-audio tap via the PulseAudio protocol — the Linux sibling of
//! [`super::system_audio`]. Records the default sink's monitor source
//! (`@DEFAULT_MONITOR@`), which works on PipeWire desktops through
//! `pipewire-pulse` as well as on plain PulseAudio.
//!
//! Format is fixed to interleaved f32le 48 kHz stereo — the PulseAudio server
//! resamples transparently, so the encoder side needs no adaptation.

use super::{RawAudio, AUDIO_CHANNEL_CAP};
use crate::error::{AppError, AppResult};
use crate::recorder::encoder::{SYSTEM_AUDIO_CHANNELS, SYSTEM_AUDIO_RATE};
use crossbeam_channel::{Receiver, Sender};
use libpulse_binding::sample::{Format, Spec};
use libpulse_binding::stream::Direction;
use libpulse_simple_binding::Simple;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

/// ~20 ms of stereo f32 at 48 kHz per read — small enough to stay responsive
/// to stop, large enough to keep syscall overhead negligible.
const READ_CHUNK_BYTES: usize = 3840;

/// Live system-audio session. Dropping (or [`Self::stop`]) ends the stream.
pub struct PulseMonitorTap {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    pub rx: Receiver<RawAudio>,
}

impl PulseMonitorTap {
    pub fn start() -> AppResult<Self> {
        let (tx, rx) = crossbeam_channel::bounded::<RawAudio>(AUDIO_CHANNEL_CAP);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();

        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<Result<(), String>>(1);
        let join = std::thread::Builder::new()
            .name("pulse-monitor".into())
            .spawn(move || run_tap(tx, stop_flag, ready_tx))
            .map_err(|e| AppError::Other(format!("failed to spawn audio thread: {e}")))?;

        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                join: Some(join),
                rx,
            }),
            Ok(Err(e)) => Err(AppError::Other(format!("system audio: {e}"))),
            Err(_) => Err(AppError::Other("system audio init timed out".into())),
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Detach — never block finalize on audio teardown.
        let _ = self.join.take();
    }
}

impl Drop for PulseMonitorTap {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_tap(tx: Sender<RawAudio>, stop: Arc<AtomicBool>, ready: Sender<Result<(), String>>) {
    let spec = Spec {
        format: Format::FLOAT32NE,
        channels: SYSTEM_AUDIO_CHANNELS as u8,
        rate: SYSTEM_AUDIO_RATE,
    };
    debug_assert!(spec.is_valid());

    let simple = match Simple::new(
        None,                       // default server
        "Capptivo",                 // app name
        Direction::Record,
        Some("@DEFAULT_MONITOR@"),  // monitor of the default sink
        "System audio",             // stream description
        &spec,
        None, // default channel map
        None, // default buffering
    ) {
        Ok(s) => {
            let _ = ready.send(Ok(()));
            s
        }
        Err(e) => {
            // `PAErr::to_string` is an inherent method returning `Option<String>`
            // (it wraps `pa_strerror`, which may be null) — not the `ToString`
            // trait. Prefer that message; fall back to the numeric code's Debug
            // form when none is available. (Do not "simplify" to `.to_string()`.)
            let _ = ready.send(Err(e.to_string().unwrap_or_else(|| format!("{e:?}"))));
            return;
        }
    };

    let mut buf = vec![0u8; READ_CHUNK_BYTES];
    while !stop.load(Ordering::Relaxed) {
        match simple.read(&mut buf) {
            Ok(()) => {
                let _ = tx.try_send(RawAudio {
                    data: buf.clone(),
                    sample_rate: SYSTEM_AUDIO_RATE,
                    channels: SYSTEM_AUDIO_CHANNELS,
                });
            }
            Err(e) => {
                tracing::warn!(%e, "pulse monitor read failed; stopping tap");
                break;
            }
        }
    }
}

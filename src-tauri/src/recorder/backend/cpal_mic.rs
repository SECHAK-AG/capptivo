//! Platform microphone capture via cpal (Core Audio / WASAPI).
//!
//! One path for macOS and Windows so Bluetooth headsets (AirPods, etc.) use the
//! same Core Audio / WASAPI input stack as every other app — not ScreenCaptureKit's
//! `captureMicrophone`, which lies about sample rate and often delivers silence
//! on BT devices.
//!
//! Requires **cpal ≥ 0.17** — 0.16 segfaults in CoreAudio device enumeration on
//! macOS 26+.
//!
//! The device's native rate/channels are reported honestly through [`RawAudio`];
//! the encoder locks that format and lets FFmpeg convert. No resampling here.
//!
//! ## Warm session
//! Opening a BT input can take ~0.5–1s. The recorder warms the selected mic on
//! pick (stream open, samples discarded), then [`take_or_start`] arms the same
//! stream with the capture epoch so Record doesn't pay that open latency again.
//! At most one warm session exists process-wide.

use super::{CaptureHandle, RawAudio, AUDIO_CHANNEL_CAP};
use crate::error::{AppError, AppResult};
use crate::recorder::types::RecorderConfig;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{DeviceId, SampleFormat};
use crossbeam_channel::{Receiver, Sender};
use parking_lot::Mutex;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

/// Shared gate: `None` = warm (discard); `Some(epoch)` = forward with timestamps.
type EpochGate = Arc<Mutex<Option<Instant>>>;

/// Live microphone session. Dropping (or [`Self::stop`]) ends the stream.
pub struct CpalMic {
    stop: Arc<AtomicBool>,
    epoch: EpochGate,
    join: Option<JoinHandle<()>>,
    pub rx: Receiver<RawAudio>,
}

impl CpalMic {
    /// Open and start forwarding immediately (cold path / no warm session).
    pub fn start(device_id: Option<&str>, label: Option<&str>, epoch: Instant) -> AppResult<Self> {
        Self::spawn(device_id, label, Some(epoch))
    }

    /// Open the stream but discard samples until [`Self::arm`].
    pub fn start_warm(device_id: Option<&str>, label: Option<&str>) -> AppResult<Self> {
        Self::spawn(device_id, label, None)
    }

    /// Switch a warm session into recording: drain any race packets, then stamp
    /// against the capture epoch.
    pub fn arm(&self, epoch: Instant) {
        while self.rx.try_recv().is_ok() {}
        *self.epoch.lock() = Some(epoch);
    }

    fn spawn(
        device_id: Option<&str>,
        label: Option<&str>,
        epoch: Option<Instant>,
    ) -> AppResult<Self> {
        let (tx, rx) = crossbeam_channel::bounded::<RawAudio>(AUDIO_CHANNEL_CAP);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let epoch_gate: EpochGate = Arc::new(Mutex::new(epoch));
        let epoch_for_thread = epoch_gate.clone();
        let device_id = device_id.map(str::to_owned);
        let label = label.map(str::to_owned);

        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<Result<(), String>>(1);
        let join = std::thread::Builder::new()
            .name("cpal-mic".into())
            .spawn(move || {
                run_mic(
                    tx,
                    stop_flag,
                    epoch_for_thread,
                    ready_tx,
                    device_id,
                    label,
                )
            })
            .map_err(|e| AppError::Other(format!("failed to spawn mic thread: {e}")))?;

        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                epoch: epoch_gate,
                join: Some(join),
                rx,
            }),
            Ok(Err(e)) => Err(AppError::Other(format!("microphone: {e}"))),
            Err(_) => Err(AppError::Other("microphone init timed out".into())),
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Detach — never block finalize on audio teardown.
        let _ = self.join.take();
    }
}

impl Drop for CpalMic {
    fn drop(&mut self) {
        self.stop();
    }
}

// --- Process-wide warm slot ---------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
struct WarmKey {
    /// Stable cpal DeviceId string (or legacy name). Empty → default input.
    device_id: Option<String>,
}

impl WarmKey {
    fn from_parts(device_id: Option<&str>) -> Self {
        Self {
            device_id: normalize_id(device_id),
        }
    }
}

fn normalize_id(id: Option<&str>) -> Option<String> {
    id.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

struct WarmSlot {
    key: WarmKey,
    mic: CpalMic,
}

static WARM: Mutex<Option<WarmSlot>> = Mutex::new(None);

/// Keep the selected mic open (discarding) so Record can reuse it. Same device
/// already warm → no-op. Different device → replace. Failures are soft for the
/// UI — Record still cold-opens.
pub fn warm_microphone(device_id: Option<&str>, label: Option<&str>) -> AppResult<()> {
    let key = WarmKey::from_parts(device_id);
    let label = normalize_id(label);

    {
        let guard = WARM.lock();
        if let Some(slot) = guard.as_ref() {
            if slot.key == key {
                return Ok(());
            }
        }
    }

    // Open before swapping so a failed warm leaves the previous session intact.
    let mic = CpalMic::start_warm(key.device_id.as_deref(), label.as_deref())?;
    let mut guard = WARM.lock();
    *guard = Some(WarmSlot { key, mic });
    Ok(())
}

/// Tear down the warm session (mic off, bar dismiss, quit). Idempotent.
pub fn cool_microphone() {
    *WARM.lock() = None;
}

/// Prefer a matching warm session (armed to `epoch`); otherwise cold-open.
pub fn take_or_start(
    device_id: Option<&str>,
    label: Option<&str>,
    epoch: Instant,
) -> AppResult<CpalMic> {
    let key = WarmKey::from_parts(device_id);
    let mut guard = WARM.lock();
    if let Some(slot) = guard.take() {
        if slot.key == key {
            slot.mic.arm(epoch);
            return Ok(slot.mic);
        }
        // Wrong device — drop the warm mic, fall through to cold open.
        drop(slot);
    }
    drop(guard);
    CpalMic::start(device_id, label, epoch)
}

/// Attach mic to a capture handle: warm reuse when possible.
pub fn attach_configured_mic(handle: &mut CaptureHandle, config: &RecorderConfig) {
    if !config.capture_microphone {
        return;
    }
    match take_or_start(
        config.microphone_device_id.as_deref(),
        config.microphone_label.as_deref(),
        handle.epoch,
    ) {
        Ok(tap) => {
            let rx = tap.rx.clone();
            handle.attach_mic(rx, move || drop(tap));
        }
        Err(e) => {
            tracing::warn!(%e, "microphone unavailable; continuing without mic");
        }
    }
}

fn run_mic(
    tx: Sender<RawAudio>,
    stop: Arc<AtomicBool>,
    epoch: EpochGate,
    ready: Sender<Result<(), String>>,
    device_id: Option<String>,
    label: Option<String>,
) {
    let built = build_mic_stream(tx, epoch, device_id.as_deref(), label.as_deref());
    let stream = match built {
        Ok(stream) => {
            let _ = ready.send(Ok(()));
            stream
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    drop(stream);
}

fn build_mic_stream(
    tx: Sender<RawAudio>,
    epoch: EpochGate,
    device_id: Option<&str>,
    label: Option<&str>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = pick_input_device(&host, device_id, label)?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("input config: {e}"))?;

    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();
    let sample_rate = stream_config.sample_rate;
    let channels = stream_config.channels;

    let err_fn = |e| tracing::warn!(%e, "mic stream error");
    // Skip conversion while warming (`epoch` is None) — BT devices keep pumping.
    let stream = match sample_format {
        SampleFormat::F32 => {
            let tx = tx.clone();
            let epoch = epoch.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _| {
                        forward_pcm(&tx, &epoch, sample_rate, channels, data.iter().copied())
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("build mic stream: {e}"))?
        }
        SampleFormat::I16 => {
            let tx = tx.clone();
            let epoch = epoch.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _| {
                        let Some(t0) = *epoch.lock() else {
                            return;
                        };
                        forward_f32(
                            &tx,
                            t0,
                            sample_rate,
                            channels,
                            data.iter().map(|&s| f32::from(s) / 32768.0),
                        );
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("build mic stream: {e}"))?
        }
        SampleFormat::U16 => {
            let tx = tx.clone();
            let epoch = epoch.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _| {
                        let Some(t0) = *epoch.lock() else {
                            return;
                        };
                        forward_f32(
                            &tx,
                            t0,
                            sample_rate,
                            channels,
                            data.iter().map(|&s| (f32::from(s) - 32768.0) / 32768.0),
                        );
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("build mic stream: {e}"))?
        }
        other => return Err(format!("unsupported sample format {other:?}")),
    };

    stream.play().map_err(|e| format!("start mic: {e}"))?;
    Ok(stream)
}

fn forward_pcm(
    tx: &Sender<RawAudio>,
    epoch: &EpochGate,
    sample_rate: u32,
    channels: u16,
    samples: impl IntoIterator<Item = f32>,
) {
    let Some(t0) = *epoch.lock() else {
        return;
    };
    forward_f32(tx, t0, sample_rate, channels, samples);
}

fn forward_f32(
    tx: &Sender<RawAudio>,
    epoch: Instant,
    sample_rate: u32,
    channels: u16,
    samples: impl IntoIterator<Item = f32>,
) {
    let mut data = Vec::new();
    for s in samples {
        data.extend_from_slice(&s.to_le_bytes());
    }
    if data.is_empty() {
        return;
    }
    super::forward_audio(
        tx,
        RawAudio {
            data,
            sample_rate,
            channels,
            timestamp: epoch.elapsed(),
        },
        "microphone",
    );
}

fn pick_input_device(
    host: &cpal::Host,
    device_id: Option<&str>,
    label: Option<&str>,
) -> Result<cpal::Device, String> {
    // Stable cpal DeviceId ("CoreAudio:…" / "Wasapi:…") from the picker.
    if let Some(id) = device_id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(parsed) = DeviceId::from_str(id) {
            if let Some(d) = host.device_by_id(&parsed) {
                return Ok(d);
            }
        }
    }

    let inputs: Vec<_> = host
        .input_devices()
        .map_err(|e| format!("list inputs: {e}"))?
        .collect();

    if let Some(label) = label.map(str::trim).filter(|s| !s.is_empty()) {
        for d in &inputs {
            if device_label(d).as_deref() == Some(label) {
                return Ok(d.clone());
            }
        }
    }
    // Legacy: older sessions stored the human name as device_id.
    if let Some(id) = device_id.map(str::trim).filter(|s| !s.is_empty()) {
        for d in &inputs {
            if device_label(d).as_deref() == Some(id) {
                return Ok(d.clone());
            }
        }
    }
    host.default_input_device()
        .ok_or_else(|| "no default input device".to_string())
}

fn device_label(device: &cpal::Device) -> Option<String> {
    device
        .description()
        .ok()
        .map(|d| d.name().to_string())
}

#[cfg(test)]
mod tests {
    use super::WarmKey;

    #[test]
    fn pick_prefers_label_then_id_name() {
        let names = ["MacBook Pro Microphone", "John's AirPods Pro", "Ioniq"];
        assert_eq!(
            pick_input_name_fallback(names, Some("Ioniq"), Some("John's AirPods Pro")),
            Some("John's AirPods Pro")
        );
        assert_eq!(
            pick_input_name_fallback(names, Some("John's AirPods Pro"), None),
            Some("John's AirPods Pro")
        );
        assert_eq!(pick_input_name_fallback(names, Some("missing"), None), None);
    }

    #[test]
    fn warm_key_normalizes_empty() {
        assert_eq!(
            WarmKey::from_parts(Some("  ")),
            WarmKey::from_parts(None)
        );
        assert_eq!(
            WarmKey::from_parts(Some("CoreAudio:1")),
            WarmKey::from_parts(Some("CoreAudio:1"))
        );
    }

    /// Label/id name matching used when DeviceId parse fails (Linux Pulse / legacy).
    fn pick_input_name_fallback<'a>(
        names: impl IntoIterator<Item = &'a str>,
        device_id: Option<&str>,
        label: Option<&str>,
    ) -> Option<&'a str> {
        let names: Vec<&'a str> = names.into_iter().collect();
        if let Some(label) = label.map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(n) = names.iter().copied().find(|&n| n == label) {
                return Some(n);
            }
        }
        if let Some(id) = device_id.map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(n) = names.iter().copied().find(|&n| n == id) {
                return Some(n);
            }
        }
        None
    }
}

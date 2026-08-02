//! System-audio tap via WASAPI loopback — the Windows sibling of
//! [`super::system_audio`]. cpal transparently enables loopback when an input
//! stream is opened on an *output* device, yielding the desktop mix.
//!
//! The device's native rate/channels are reported honestly through
//! [`RawAudio`]; the encoder forwards them to FFmpeg, so no resampling happens
//! here.

use super::{RawAudio, AUDIO_CHANNEL_CAP};
use crate::error::{AppError, AppResult};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use crossbeam_channel::{Receiver, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

/// Live system-audio session. Dropping (or [`Self::stop`]) ends the stream.
pub struct WasapiLoopback {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    pub rx: Receiver<RawAudio>,
}

impl WasapiLoopback {
    pub fn start(epoch: Instant) -> AppResult<Self> {
        let (tx, rx) = crossbeam_channel::bounded::<RawAudio>(AUDIO_CHANNEL_CAP);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();

        // The whole cpal session lives on one thread: `Stream` is neither Send
        // nor Sync, and it must stay alive for the duration of the capture.
        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<Result<(), String>>(1);
        let join = std::thread::Builder::new()
            .name("wasapi-loopback".into())
            .spawn(move || run_loopback(tx, stop_flag, ready_tx, epoch))
            .map_err(|e| AppError::Other(format!("failed to spawn loopback thread: {e}")))?;

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

impl Drop for WasapiLoopback {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_loopback(
    tx: Sender<RawAudio>,
    stop: Arc<AtomicBool>,
    ready: Sender<Result<(), String>>,
    epoch: Instant,
) {
    let built = build_stream(tx, epoch);
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

fn build_stream(tx: Sender<RawAudio>, epoch: Instant) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "no default output device".to_string())?;
    let config = device
        .default_output_config()
        .map_err(|e| format!("output config: {e}"))?;

    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();
    let sample_rate = stream_config.sample_rate.0;
    let channels = stream_config.channels;

    let err_fn = |e| tracing::warn!(%e, "WASAPI loopback stream error");
    let push = move |samples: Vec<f32>| {
        if samples.is_empty() {
            return;
        }
        let mut data = Vec::with_capacity(samples.len() * 4);
        for s in samples {
            data.extend_from_slice(&s.to_le_bytes());
        }
        let _ = tx.try_send(RawAudio {
            data,
            sample_rate,
            channels,
            timestamp: epoch.elapsed(),
        });
    };

    // The shared-mode mix format is virtually always f32, but cover the
    // integer formats WASAPI can legally report.
    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _| push(data.to_vec()),
                err_fn,
                None,
            )
            .map_err(|e| format!("build loopback stream: {e}"))?,
        SampleFormat::I16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    push(data.iter().map(|&s| f32::from(s) / 32768.0).collect())
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("build loopback stream: {e}"))?,
        SampleFormat::U16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    push(
                        data.iter()
                            .map(|&s| (f32::from(s) - 32768.0) / 32768.0)
                            .collect(),
                    )
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("build loopback stream: {e}"))?,
        other => return Err(format!("unsupported sample format {other:?}")),
    };

    stream.play().map_err(|e| format!("start loopback: {e}"))?;
    Ok(stream)
}

/// Microphone capture on a WASAPI *capture* endpoint (never the loopback device).
pub struct WasapiMic {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    pub rx: Receiver<RawAudio>,
}

impl WasapiMic {
    pub fn start(device_id: Option<&str>, label: Option<&str>, epoch: Instant) -> AppResult<Self> {
        let (tx, rx) = crossbeam_channel::bounded::<RawAudio>(AUDIO_CHANNEL_CAP);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let device_id = device_id.map(str::to_owned);
        let label = label.map(str::to_owned);

        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<Result<(), String>>(1);
        let join = std::thread::Builder::new()
            .name("wasapi-mic".into())
            .spawn(move || run_mic(tx, stop_flag, ready_tx, device_id, label, epoch))
            .map_err(|e| AppError::Other(format!("failed to spawn mic thread: {e}")))?;

        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                join: Some(join),
                rx,
            }),
            Ok(Err(e)) => Err(AppError::Other(format!("microphone: {e}"))),
            Err(_) => Err(AppError::Other("microphone init timed out".into())),
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.join.take();
    }
}

impl Drop for WasapiMic {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_mic(
    tx: Sender<RawAudio>,
    stop: Arc<AtomicBool>,
    ready: Sender<Result<(), String>>,
    device_id: Option<String>,
    label: Option<String>,
    epoch: Instant,
) {
    let built = build_mic_stream(tx, device_id.as_deref(), label.as_deref(), epoch);
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
    device_id: Option<&str>,
    label: Option<&str>,
    epoch: Instant,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = pick_input_device(&host, device_id, label)?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("input config: {e}"))?;

    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();
    let sample_rate = stream_config.sample_rate.0;
    let channels = stream_config.channels;

    let err_fn = |e| tracing::warn!(%e, "WASAPI mic stream error");
    let push = move |samples: Vec<f32>| {
        if samples.is_empty() {
            return;
        }
        let mut data = Vec::with_capacity(samples.len() * 4);
        for s in samples {
            data.extend_from_slice(&s.to_le_bytes());
        }
        let _ = tx.try_send(RawAudio {
            data,
            sample_rate,
            channels,
            timestamp: epoch.elapsed(),
        });
    };

    let stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _| push(data.to_vec()),
                err_fn,
                None,
            )
            .map_err(|e| format!("build mic stream: {e}"))?,
        SampleFormat::I16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    push(data.iter().map(|&s| f32::from(s) / 32768.0).collect())
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("build mic stream: {e}"))?,
        SampleFormat::U16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    push(
                        data.iter()
                            .map(|&s| (f32::from(s) - 32768.0) / 32768.0)
                            .collect(),
                    )
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("build mic stream: {e}"))?,
        other => return Err(format!("unsupported sample format {other:?}")),
    };

    stream.play().map_err(|e| format!("start mic: {e}"))?;
    Ok(stream)
}

fn pick_input_device(
    host: &cpal::Host,
    device_id: Option<&str>,
    label: Option<&str>,
) -> Result<cpal::Device, String> {
    let inputs: Vec<_> = host
        .input_devices()
        .map_err(|e| format!("list inputs: {e}"))?
        .collect();

    if let Some(label) = label.map(str::trim).filter(|s| !s.is_empty()) {
        for d in &inputs {
            if d.name().ok().as_deref() == Some(label) {
                return Ok(d.clone());
            }
        }
    }
    if let Some(id) = device_id.map(str::trim).filter(|s| !s.is_empty()) {
        for d in &inputs {
            if d.name().ok().as_deref() == Some(id) {
                return Ok(d.clone());
            }
        }
    }
    host.default_input_device()
        .ok_or_else(|| "no default input device".to_string())
}

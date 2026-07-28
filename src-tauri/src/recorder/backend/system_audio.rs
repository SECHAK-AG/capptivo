//! System-audio tap via ScreenCaptureKit (companion to video `scap`).
//!
//! Uses `screencapturekit-sys` directly — the high-level `CMSampleBuffer::new`
//! always calls `get_frame_info()`, which null-derefs on audio buffers (no
//! sample-attachments array). The sys callback hands us the raw
//! `CMSampleBufferRef` so we can pull PCM without that path.
//!
//! ponytail: dual SCStream (video + audio). Ceiling = 2× SCK sessions; upgrade
//! path = Cap scap once CI has Xcode, and fold audio into the video stream.

use super::{RawAudio, AUDIO_CHANNEL_CAP};
use crate::error::{AppError, AppResult};
use crate::recorder::encoder::{SYSTEM_AUDIO_CHANNELS, SYSTEM_AUDIO_RATE};
use crossbeam_channel::{Receiver, Sender};
use objc::{msg_send, sel, sel_impl};
use objc_id::Id;
use screencapturekit_sys::cm_sample_buffer_ref::CMSampleBufferRef;
use screencapturekit_sys::content_filter::{UnsafeContentFilter, UnsafeInitParams};
use screencapturekit_sys::os_types::base::{CMTime, CMTimeScale, BOOL};
use screencapturekit_sys::shareable_content::UnsafeSCShareableContent;
use screencapturekit_sys::stream::UnsafeSCStream;
use screencapturekit_sys::stream_configuration::{
    UnsafeStreamConfiguration, UnsafeStreamConfigurationRef,
};
use screencapturekit_sys::stream_error_handler::UnsafeSCStreamError;
use screencapturekit_sys::stream_output_handler::UnsafeSCStreamOutput;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

const OUTPUT_TYPE_AUDIO: u8 = 1;

struct QuietErrors;
impl UnsafeSCStreamError for QuietErrors {
    fn handle_error(&self) {
        tracing::warn!("system-audio SCStream error");
    }
}

struct AudioOut {
    tx: Sender<RawAudio>,
}

impl UnsafeSCStreamOutput for AudioOut {
    fn did_output_sample_buffer(&self, sample: Id<CMSampleBufferRef>, of_type: u8) {
        if of_type != OUTPUT_TYPE_AUDIO {
            return;
        }
        // get_av_audio_buffer_list panics on CoreMedia errors — never abort the app.
        let chunk = catch_unwind(AssertUnwindSafe(|| pcm_from_ref(&sample))).ok().flatten();
        if let Some(chunk) = chunk {
            let _ = self.tx.try_send(chunk);
        }
    }
}

/// Live system-audio session. Dropping (or [`Self::stop`]) ends the SCStream.
pub struct SystemAudioTap {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    pub rx: Receiver<RawAudio>,
}

impl SystemAudioTap {
    /// Start capturing system audio for the same `display:<id>` / `window:<id>`
    /// as the video source.
    pub fn start(source_id: &str) -> AppResult<Self> {
        let (kind, id) = parse_source_id(source_id)?;
        let (tx, rx) = crossbeam_channel::bounded::<RawAudio>(AUDIO_CHANNEL_CAP);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();

        let join = std::thread::Builder::new()
            .name("sck-system-audio".into())
            .spawn(move || {
                if let Err(e) = run_tap(kind, id, tx, stop_flag) {
                    tracing::warn!(%e, "system-audio tap exited");
                }
            })
            .map_err(|e| AppError::Other(format!("failed to spawn system-audio thread: {e}")))?;

        Ok(Self {
            stop,
            join: Some(join),
            rx,
        })
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Detach — never block finalize on SCK teardown.
        let _ = self.join.take();
    }
}

impl Drop for SystemAudioTap {
    fn drop(&mut self) {
        self.stop();
    }
}

enum SourceKind {
    Display,
    Window,
}

fn parse_source_id(source_id: &str) -> AppResult<(SourceKind, u32)> {
    let (kind, id_str) = source_id
        .split_once(':')
        .ok_or_else(|| AppError::InvalidSource(source_id.to_string()))?;
    let id: u32 = id_str
        .parse()
        .map_err(|_| AppError::InvalidSource(source_id.to_string()))?;
    let kind = match kind {
        "display" => SourceKind::Display,
        "window" => SourceKind::Window,
        _ => return Err(AppError::InvalidSource(source_id.to_string())),
    };
    Ok((kind, id))
}

fn run_tap(
    kind: SourceKind,
    id: u32,
    tx: Sender<RawAudio>,
    stop: Arc<AtomicBool>,
) -> AppResult<()> {
    let content = UnsafeSCShareableContent::get()
        .map_err(|e| AppError::Other(format!("SCShareableContent: {e}")))?;

    let params = match kind {
        SourceKind::Display => {
            let display = content
                .displays()
                .into_iter()
                .find(|d| d.get_display_id() == id)
                .ok_or_else(|| AppError::InvalidSource(format!("display:{id}")))?;
            UnsafeInitParams::Display(display)
        }
        SourceKind::Window => {
            let window = content
                .windows()
                .into_iter()
                .find(|w| w.get_window_id() == id)
                .ok_or_else(|| AppError::InvalidSource(format!("window:{id}")))?;
            UnsafeInitParams::DesktopIndependentWindow(window)
        }
    };

    let filter = UnsafeContentFilter::init(params);

    // Tiny video surface — we only register Audio output. 1 fps avoids burning
    // cycles on unused screen frames.
    let config = UnsafeStreamConfiguration {
        width: 2,
        height: 2,
        captures_audio: BOOL::from(true),
        sample_rate: SYSTEM_AUDIO_RATE,
        channel_count: SYSTEM_AUDIO_CHANNELS as u32,
        excludes_current_process_audio: BOOL::from(true),
        minimum_frame_interval: CMTime {
            value: 1,
            timescale: 1 as CMTimeScale,
            epoch: 0,
            flags: 1,
        },
        ..Default::default()
    };
    let config_ref: Id<UnsafeStreamConfigurationRef> = config.into();
    // screencapturekit-sys From impl omits sample_rate / channel_count setters.
    unsafe {
        let _: () = msg_send![config_ref, setSampleRate: SYSTEM_AUDIO_RATE];
        let _: () = msg_send![config_ref, setChannelCount: SYSTEM_AUDIO_CHANNELS as u32];
        let _: () = msg_send![config_ref, setExcludesCurrentProcessAudio: BOOL::from(true)];
    }

    let stream = UnsafeSCStream::init(filter, config_ref, QuietErrors);
    stream.add_stream_output(AudioOut { tx }, OUTPUT_TYPE_AUDIO);
    stream
        .start_capture()
        .map_err(|e| AppError::Other(format!("failed to start system-audio capture: {e}")))?;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    // Do **not** call `stop_capture()` here. On audio-only companion streams it
    // can block for minutes (completion handler never fires), which freezes
    // finalize → editor open. Dropping the SCStream releases it promptly.
    drop(stream);
    Ok(())
}

fn pcm_from_ref(sample: &CMSampleBufferRef) -> Option<RawAudio> {
    let buffers = sample.get_av_audio_buffer_list();
    if buffers.is_empty() {
        return None;
    }

    let channels = if buffers.len() == 1 {
        buffers[0].number_channels.max(1) as u16
    } else {
        buffers.len() as u16
    };

    let data = if buffers.len() == 1 {
        buffers.into_iter().next().unwrap().data
    } else {
        interleave_planar_f32(buffers)?
    };

    if data.is_empty() {
        return None;
    }
    Some(RawAudio {
        data,
        sample_rate: SYSTEM_AUDIO_RATE,
        channels,
    })
}

/// Pack N mono planar buffers into interleaved LRLR… for FFmpeg `f32le`.
fn interleave_planar_f32(
    buffers: Vec<screencapturekit_sys::audio_buffer::CopiedAudioBuffer>,
) -> Option<Vec<u8>> {
    let sample_bytes = 4;
    let samples = buffers.iter().map(|b| b.data.len() / sample_bytes).min()?;
    if samples == 0 {
        return None;
    }
    let mut out = Vec::with_capacity(samples * buffers.len() * sample_bytes);
    for i in 0..samples {
        for buf in &buffers {
            let start = i * sample_bytes;
            out.extend_from_slice(&buf.data[start..start + sample_bytes]);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn interleave_two_mono_planes() {
        let l: Vec<u8> = [1f32, 2f32].into_iter().flat_map(|f| f.to_le_bytes()).collect();
        let r: Vec<u8> = [3f32, 4f32].into_iter().flat_map(|f| f.to_le_bytes()).collect();
        let buffers = vec![
            screencapturekit_sys::audio_buffer::CopiedAudioBuffer {
                number_channels: 1,
                data: l,
            },
            screencapturekit_sys::audio_buffer::CopiedAudioBuffer {
                number_channels: 1,
                data: r,
            },
        ];
        let out = super::interleave_planar_f32(buffers).unwrap();
        let samples: Vec<f32> = out
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        assert_eq!(samples, vec![1.0, 3.0, 2.0, 4.0]);
    }
}

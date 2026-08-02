//! System + microphone audio via one companion ScreenCaptureKit stream.
//!
//! Uses `screencapturekit-sys` directly — the high-level `CMSampleBuffer::new`
//! always calls `get_frame_info()`, which null-derefs on audio buffers (no
//! sample-attachments array). The sys callback hands us the raw
//! `CMSampleBufferRef` so we can pull PCM without that path.
//!
//! Mic uses SCK `captureMicrophone` / output type `2` so the
//! camera WebView's getUserMedia never shares an AVFoundation session with
//! narration capture.
//!
//! ponytail: dual SCStream (video via scap + this audio companion). Ceiling =
//! 2× SCK sessions; upgrade path = Cap scap once CI has Xcode, and fold audio
//! into the video stream.

use super::{RawAudio, AUDIO_CHANNEL_CAP};
use crate::error::{AppError, AppResult};
use crate::recorder::encoder::{SYSTEM_AUDIO_CHANNELS, SYSTEM_AUDIO_RATE};
use crossbeam_channel::{Receiver, Sender};
use objc::runtime::{Object, BOOL as ObjcBool, YES};
use objc::{class, msg_send, sel, sel_impl};
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
use std::ffi::{c_void, CString};
use std::os::raw::c_char;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

const OUTPUT_TYPE_AUDIO: u8 = 1;
const OUTPUT_TYPE_MICROPHONE: u8 = 2;
/// `RTLD_DEFAULT` — search every loaded image.
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

#[link(name = "System", kind = "dylib")]
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// What this companion stream should deliver.
#[derive(Debug, Clone)]
pub struct CompanionAudioOpts {
    pub system: bool,
    pub microphone: bool,
    pub microphone_device_id: Option<String>,
    pub microphone_label: Option<String>,
}

impl CompanionAudioOpts {
    pub fn any(&self) -> bool {
        self.system || self.microphone
    }
}

struct QuietErrors;
impl UnsafeSCStreamError for QuietErrors {
    fn handle_error(&self) {
        tracing::warn!("companion-audio SCStream error");
    }
}

struct AudioOut {
    system_tx: Option<Sender<RawAudio>>,
    mic_tx: Option<Sender<RawAudio>>,
    /// Host-clock ns at video [`CaptureHandle::epoch`] — same axis as frame PTS.
    epoch_host_ns: u64,
}

impl UnsafeSCStreamOutput for AudioOut {
    fn did_output_sample_buffer(&self, sample: Id<CMSampleBufferRef>, of_type: u8) {
        let tx = match of_type {
            OUTPUT_TYPE_AUDIO => self.system_tx.as_ref(),
            OUTPUT_TYPE_MICROPHONE => self.mic_tx.as_ref(),
            _ => None,
        };
        let Some(tx) = tx else {
            return;
        };
        // get_av_audio_buffer_list panics on CoreMedia errors — never abort the app.
        let chunk = catch_unwind(AssertUnwindSafe(|| {
            pcm_from_ref(&sample, self.epoch_host_ns)
        }))
        .ok()
        .flatten();
        if let Some(chunk) = chunk {
            let _ = tx.try_send(chunk);
        }
    }
}

/// Live companion-audio session. Dropping (or [`Self::stop`]) ends the SCStream.
pub struct SystemAudioTap {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    pub system_rx: Option<Receiver<RawAudio>>,
    pub mic_rx: Option<Receiver<RawAudio>>,
}

impl SystemAudioTap {
    /// Start capturing system and/or mic audio for `display:<id>` / `window:<id>`.
    /// For mic-only sessions (e.g. iOS device video), pass a real display id —
    /// SCK still needs a content filter; the 2×2 video surface is unused.
    ///
    /// `epoch_host_ns` must match the video stream's capture epoch host clock
    /// so audio PTS and frame PTS share one timeline.
    pub fn start(source_id: &str, opts: CompanionAudioOpts, epoch_host_ns: u64) -> AppResult<Self> {
        if !opts.any() {
            return Err(AppError::Other("companion audio: nothing requested".into()));
        }
        let (kind, id) = parse_source_id(source_id)?;
        let (system_tx, system_rx) = if opts.system {
            let (tx, rx) = crossbeam_channel::bounded::<RawAudio>(AUDIO_CHANNEL_CAP);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let (mic_tx, mic_rx) = if opts.microphone {
            let (tx, rx) = crossbeam_channel::bounded::<RawAudio>(AUDIO_CHANNEL_CAP);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };

        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let mic_device_id = opts.microphone_device_id.clone();
        let mic_label = opts.microphone_label.clone();
        let want_mic = opts.microphone;
        let want_system = opts.system;

        let join = std::thread::Builder::new()
            .name("sck-companion-audio".into())
            .spawn(move || {
                if let Err(e) = run_tap(
                    kind,
                    id,
                    system_tx,
                    mic_tx,
                    want_system,
                    want_mic,
                    mic_device_id,
                    mic_label,
                    epoch_host_ns,
                    stop_flag,
                ) {
                    tracing::warn!(%e, "companion-audio tap exited");
                }
            })
            .map_err(|e| AppError::Other(format!("failed to spawn companion-audio thread: {e}")))?;

        Ok(Self {
            stop,
            join: Some(join),
            system_rx,
            mic_rx,
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

#[allow(clippy::too_many_arguments)]
fn run_tap(
    kind: SourceKind,
    id: u32,
    system_tx: Option<Sender<RawAudio>>,
    mut mic_tx: Option<Sender<RawAudio>>,
    want_system: bool,
    want_mic: bool,
    mic_device_id: Option<String>,
    mic_label: Option<String>,
    epoch_host_ns: u64,
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

    // Tiny video surface — we only register audio / mic outputs. 1 fps avoids
    // burning cycles on unused screen frames.
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

    let mut mic_enabled = want_mic;
    if want_mic {
        if enable_microphone_capture(&config_ref, mic_device_id.as_deref(), mic_label.as_deref()) {
            // ok
        } else if want_system {
            tracing::warn!("SCK captureMicrophone unavailable; continuing without mic");
            mic_tx = None;
            mic_enabled = false;
        } else {
            return Err(AppError::Other(
                "microphone capture unavailable on this macOS".into(),
            ));
        }
    }

    let stream = UnsafeSCStream::init(filter, config_ref, QuietErrors);
    if want_system {
        if let Some(tx) = system_tx {
            stream.add_stream_output(
                AudioOut {
                    system_tx: Some(tx),
                    mic_tx: None,
                    epoch_host_ns,
                },
                OUTPUT_TYPE_AUDIO,
            );
        }
    }
    if mic_enabled {
        if let Some(tx) = mic_tx {
            stream.add_stream_output(
                AudioOut {
                    system_tx: None,
                    mic_tx: Some(tx),
                    epoch_host_ns,
                },
                OUTPUT_TYPE_MICROPHONE,
            );
        }
    }

    stream
        .start_capture()
        .map_err(|e| AppError::Other(format!("failed to start companion-audio capture: {e}")))?;

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    // Do **not** call `stop_capture()` here. On audio-only companion streams it
    // can block for minutes (completion handler never fires), which freezes
    // finalize → editor open. Dropping the SCStream releases it promptly.
    drop(stream);
    Ok(())
}

fn enable_microphone_capture(
    config_ref: &UnsafeStreamConfigurationRef,
    device_id: Option<&str>,
    label: Option<&str>,
) -> bool {
    unsafe {
        let supports: ObjcBool =
            msg_send![config_ref, respondsToSelector: sel!(setCaptureMicrophone:)];
        if supports != YES {
            return false;
        }
        let _: () = msg_send![config_ref, setCaptureMicrophone: ObjcBool::from(true)];
        if let Some(uid) = resolve_microphone_unique_id(device_id, label) {
            if let Ok(c) = CString::new(uid) {
                let ns: *mut Object =
                    msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
                if !ns.is_null() {
                    let supports_id: ObjcBool = msg_send![
                        config_ref,
                        respondsToSelector: sel!(setMicrophoneCaptureDeviceID:)
                    ];
                    if supports_id == YES {
                        let _: () = msg_send![config_ref, setMicrophoneCaptureDeviceID: ns];
                    }
                }
            }
        }
        true
    }
}

/// Match WebView deviceId / label onto an `AVCaptureDevice.uniqueID`.
fn resolve_microphone_unique_id(device_id: Option<&str>, label: Option<&str>) -> Option<String> {
    unsafe {
        let pool: *mut Object = msg_send![class!(NSAutoreleasePool), new];
        let result = resolve_microphone_unique_id_inner(device_id, label);
        let _: () = msg_send![pool, release];
        result
    }
}

unsafe fn resolve_microphone_unique_id_inner(
    device_id: Option<&str>,
    label: Option<&str>,
) -> Option<String> {
    let media = dynamic_nsstring_const("AVMediaTypeAudio")?;
    let devices: *mut Object = msg_send![class!(AVCaptureDevice), devicesWithMediaType: media];
    if devices.is_null() {
        return None;
    }
    let count: usize = msg_send![devices, count];
    let label = label.map(str::trim).filter(|s| !s.is_empty());
    let device_id = device_id.map(str::trim).filter(|s| !s.is_empty());

    if let Some(label) = label {
        for i in 0..count {
            let device: *mut Object = msg_send![devices, objectAtIndex: i];
            let name: *mut Object = msg_send![device, localizedName];
            if ns_eq(name, label) {
                return ns_to_string(msg_send![device, uniqueID]);
            }
        }
    }
    if let Some(id) = device_id {
        for i in 0..count {
            let device: *mut Object = msg_send![devices, objectAtIndex: i];
            let uid: *mut Object = msg_send![device, uniqueID];
            if ns_eq(uid, id) {
                return Some(id.to_string());
            }
        }
    }
    None
}

unsafe fn ns_eq(ns: *mut Object, rust: &str) -> bool {
    if ns.is_null() {
        return false;
    }
    let utf8: *const std::os::raw::c_char = msg_send![ns, UTF8String];
    if utf8.is_null() {
        return false;
    }
    std::ffi::CStr::from_ptr(utf8)
        .to_str()
        .map(|s| s == rust)
        .unwrap_or(false)
}

unsafe fn ns_to_string(ns: *mut Object) -> Option<String> {
    if ns.is_null() {
        return None;
    }
    let utf8: *const std::os::raw::c_char = msg_send![ns, UTF8String];
    if utf8.is_null() {
        return None;
    }
    std::ffi::CStr::from_ptr(utf8)
        .to_str()
        .ok()
        .map(str::to_owned)
}

unsafe fn dynamic_nsstring_const(symbol: &str) -> Option<*mut Object> {
    let name = CString::new(symbol).ok()?;
    let addr = dlsym(RTLD_DEFAULT, name.as_ptr());
    if addr.is_null() {
        return None;
    }
    let value = *(addr as *const *mut Object);
    if value.is_null() {
        None
    } else {
        Some(value)
    }
}

fn pcm_from_ref(sample: &CMSampleBufferRef, epoch_host_ns: u64) -> Option<RawAudio> {
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

    let pts_ns = cmtime_to_ns(sample.get_presentation_timestamp());
    let timestamp = if pts_ns > 0 {
        Duration::from_nanos(pts_ns.saturating_sub(epoch_host_ns))
    } else {
        Duration::from_nanos(host_clock_ns().saturating_sub(epoch_host_ns))
    };

    Some(RawAudio {
        data,
        sample_rate: SYSTEM_AUDIO_RATE,
        channels,
        timestamp,
    })
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
        let l: Vec<u8> = [1f32, 2f32]
            .into_iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();
        let r: Vec<u8> = [3f32, 4f32]
            .into_iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();
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

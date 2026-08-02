//! Native microphone enumeration for the recorder bar.
//!
//! Must not go through WebView `getUserMedia({ audio })` — on macOS that tears
//! down the face-cam bubble's AVFoundation session.

use crate::error::AppResult;
use crate::recorder::types::MicrophoneDevice;

/// Input devices available for native mic capture (SCK / WASAPI / Pulse).
pub fn list_microphones() -> AppResult<Vec<MicrophoneDevice>> {
    Ok(list_microphones_impl())
}

#[cfg(target_os = "macos")]
fn list_microphones_impl() -> Vec<MicrophoneDevice> {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::{c_void, CString};
    use std::os::raw::c_char;

    #[link(name = "System", kind = "dylib")]
    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

    unsafe {
        let pool: *mut Object = msg_send![class!(NSAutoreleasePool), new];

        let mut out = Vec::new();
        let name = CString::new("AVMediaTypeAudio").ok();
        if let Some(name) = name {
            let addr = dlsym(RTLD_DEFAULT, name.as_ptr());
            if !addr.is_null() {
                let media = *(addr as *const *mut Object);
                if !media.is_null() {
                    let devices: *mut Object =
                        msg_send![class!(AVCaptureDevice), devicesWithMediaType: media];
                    if !devices.is_null() {
                        let count: usize = msg_send![devices, count];
                        for i in 0..count {
                            let device: *mut Object = msg_send![devices, objectAtIndex: i];
                            if device.is_null() {
                                continue;
                            }
                            let uid: *mut Object = msg_send![device, uniqueID];
                            let label_ns: *mut Object = msg_send![device, localizedName];
                            let Some(device_id) = ns_to_string(uid) else {
                                continue;
                            };
                            let label = ns_to_string(label_ns)
                                .unwrap_or_else(|| format!("Microphone {}", i + 1));
                            out.push(MicrophoneDevice { device_id, label });
                        }
                    }
                }
            }
        }

        let _: () = msg_send![pool, release];
        out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        out
    }
}

#[cfg(target_os = "macos")]
unsafe fn ns_to_string(ns: *mut objc::runtime::Object) -> Option<String> {
    use objc::{msg_send, sel, sel_impl};
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

#[cfg(any(
    all(target_os = "windows", feature = "wgc-capture"),
    all(target_os = "linux", feature = "portal-capture"),
))]
fn list_microphones_impl() -> Vec<MicrophoneDevice> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let Ok(inputs) = host.input_devices() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, device) in inputs.enumerate() {
        let label = device
            .name()
            .unwrap_or_else(|_| format!("Microphone {}", i + 1));
        out.push(MicrophoneDevice {
            device_id: label.clone(),
            label,
        });
    }
    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    out
}

#[cfg(not(any(
    target_os = "macos",
    all(target_os = "windows", feature = "wgc-capture"),
    all(target_os = "linux", feature = "portal-capture"),
)))]
fn list_microphones_impl() -> Vec<MicrophoneDevice> {
    Vec::new()
}

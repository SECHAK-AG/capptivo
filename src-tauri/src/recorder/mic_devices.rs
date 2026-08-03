//! Native microphone enumeration for the recorder bar.
//!
//! Must not go through WebView `getUserMedia({ audio })` — on macOS that tears
//! down the face-cam bubble's AVFoundation session.
//!
//! On macOS/Windows, `device_id` is cpal's stable [`cpal::DeviceId`] string so
//! capture can open via `Host::device_by_id`. On Linux, ids stay human source
//! names because Pulse capture still keys off the Pulse source name.

use crate::error::AppResult;
use crate::recorder::types::MicrophoneDevice;

/// Input devices available for native mic capture (cpal / Pulse).
pub fn list_microphones() -> AppResult<Vec<MicrophoneDevice>> {
    Ok(list_microphones_impl())
}

#[cfg(any(
    all(target_os = "macos", feature = "scap-capture"),
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
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| format!("Microphone {}", i + 1));

        #[cfg(any(
            all(target_os = "macos", feature = "scap-capture"),
            all(target_os = "windows", feature = "wgc-capture"),
        ))]
        let device_id = device
            .id()
            .map(|id| id.to_string())
            .unwrap_or_else(|_| label.clone());

        // Pulse opens by source name — keep the human label as the id.
        #[cfg(all(target_os = "linux", feature = "portal-capture"))]
        let device_id = label.clone();

        out.push(MicrophoneDevice { device_id, label });
    }
    out.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    out
}

#[cfg(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture"),
    all(target_os = "linux", feature = "portal-capture"),
))]
#[test]
fn listing_microphones_does_not_segfault() {
    // Regression: cpal 0.16 + CoreAudio on macOS 26 SIGSEGV'd in HALDeviceList
    // during input_devices(). Must stay on cpal ≥ 0.17.
    let list = list_microphones_impl();
    for mic in &list {
        assert!(!mic.device_id.is_empty(), "empty device_id for {}", mic.label);
        assert!(!mic.label.is_empty(), "empty label");
    }
}

#[cfg(not(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture"),
    all(target_os = "linux", feature = "portal-capture"),
)))]
fn list_microphones_impl() -> Vec<MicrophoneDevice> {
    Vec::new()
}

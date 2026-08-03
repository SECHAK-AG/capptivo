//! Process-wide microphone warm-up.
//!
//! On macOS/Windows the selected mic is opened via cpal before Record so
//! Bluetooth open latency is paid at pick-time. Linux (Pulse) opens fast enough
//! that warm is a no-op.

use crate::error::AppResult;

#[cfg(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture"),
))]
pub fn warm_microphone(device_id: Option<&str>, label: Option<&str>) -> AppResult<()> {
    crate::recorder::backend::cpal_mic::warm_microphone(device_id, label)
}

#[cfg(not(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture"),
)))]
pub fn warm_microphone(device_id: Option<&str>, label: Option<&str>) -> AppResult<()> {
    let _ = (device_id, label);
    Ok(())
}

#[cfg(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture"),
))]
pub fn cool_microphone() {
    crate::recorder::backend::cpal_mic::cool_microphone();
}

#[cfg(not(any(
    all(target_os = "macos", feature = "scap-capture"),
    all(target_os = "windows", feature = "wgc-capture"),
)))]
pub fn cool_microphone() {}

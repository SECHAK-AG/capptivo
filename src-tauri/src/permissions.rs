//! Permission reporting (§11). Screen recording is the critical one and is
//! queried through the capture backend — macOS gates it behind TCC, Windows
//! needs no grant, and on Linux the desktop portal's own dialog *is* the
//! permission flow. Microphone and camera are requested by the WebView via
//! `getUserMedia`, so we report them as `NotDetermined` here and let the
//! browser flow drive the prompt; the frontend can refine this later.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionState {
    Granted,
    Denied,
    NotDetermined,
    /// Not applicable on this platform / not queryable here.
    #[allow(dead_code)]
    Unknown,
}

/// The full permission picture in one struct (queried by the recorder store).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub screen_recording: PermissionState,
    pub microphone: PermissionState,
    pub camera: PermissionState,
    /// True when screen recording is usable and we can start capturing.
    pub can_record: bool,
}

/// Deep link that opens the OS settings page governing screen recording, when
/// one exists. macOS: System Settings → Privacy → Screen Recording (a grant
/// then may require an app restart). Windows and Linux need no screen-recording
/// grant, so there is nothing to open — the command becomes a no-op.
pub fn screen_recording_settings_url() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

impl PermissionStatus {
    pub fn from_screen(has_screen: bool) -> Self {
        let screen = if has_screen {
            PermissionState::Granted
        } else {
            PermissionState::Denied
        };
        Self {
            screen_recording: screen,
            // Driven by getUserMedia in the WebView; unknown until then.
            microphone: PermissionState::NotDetermined,
            camera: PermissionState::NotDetermined,
            can_record: has_screen,
        }
    }
}

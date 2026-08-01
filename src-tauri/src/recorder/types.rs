//! Data types for the recording pipeline. Pure serde structs — no Tauri, no
//! ScreenCaptureKit. These are what cross the IPC boundary and what the frontend
//! Zustand store mirrors.

use serde::{Deserialize, Serialize};

/// A capturable display or window, as shown in the recorder popover picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    /// Stable id, e.g. `"display:1"` or `"window:41233"`. Round-trips back to the
    /// backend in [`RecorderConfig::source_id`].
    pub id: String,
    pub kind: CaptureSourceKind,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    /// Base64 PNG thumbnail for the picker (optional; enumerated lazily).
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureSourceKind {
    Display,
    Window,
}

/// An attached iOS device (iPhone / iPad) whose *own screen* can be recorded over
/// USB — a CoreMediaIO capture device, not a display or a window. Kept separate
/// from [`CaptureSource`] because nothing about it is display-like: there is no
/// crop, no cursor, and the size is whatever the phone decides to send.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDevice {
    /// `device:{uniqueID}`. Round-trips back as [`RecorderConfig::source_id`].
    pub id: String,
    /// User-facing name, e.g. "Yassine's iPhone".
    pub name: String,
    pub model: Option<String>,
    /// Native size of the device's active format, or `0` when it hasn't
    /// negotiated one yet (common until the first stream).
    pub width: u32,
    pub height: u32,
    /// The device carries its own audio (muxed), so the phone's sound can be
    /// recorded alongside its screen.
    pub has_audio: bool,
}

/// Display-local crop rect (logical points), used with `display:{id}` sources.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Result of the full-screen area picker (`display:{id}` + display-local crop).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureAreaSelection {
    pub source_id: String,
    pub crop: CaptureCrop,
}

/// Everything the pipeline needs to start.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderConfig {
    pub source_id: String,
    /// Partial capture when recording a screen region (`display:{id}` + crop).
    #[serde(default)]
    pub crop: Option<CaptureCrop>,
    #[serde(default = "default_fps")]
    pub fps: u32,
    #[serde(default = "default_true")]
    pub show_cursor: bool,
  #[serde(default)]
  pub capture_system_audio: bool,
  #[serde(default)]
  pub capture_microphone: bool,
  #[serde(default)]
  pub quality: QualityPreset,
}

fn default_fps() -> u32 {
    30
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QualityPreset {
    /// ~8 Mbps @ 1080p equivalent — the default.
    #[default]
    Balanced,
    /// ~16 Mbps — crisper, larger files.
    High,
}

impl QualityPreset {
    /// Target H.264 bitrate in bits/sec for a given pixel count, so 4K recordings
    /// don't come out starved at a 1080p bitrate.
    pub fn target_bitrate(self, width: u32, height: u32) -> u64 {
        let pixels = (width as u64) * (height as u64);
        let per_mpixel = match self {
            QualityPreset::Balanced => 4_000_000,
            QualityPreset::High => 8_000_000,
        };
        // Scale off a 1080p (≈2.07 Mpixel) baseline, clamped to a sane range.
        let scaled = per_mpixel * pixels / 2_073_600;
        scaled.clamp(2_000_000, 40_000_000)
    }
}

/// The recorder state machine. Rust is the single source of truth; the tray icon,
/// HUD, and popover all render from this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RecorderState {
    Idle,
    Countdown { remaining: u32 },
    Recording,
    Paused,
    Finalizing,
    Error { message: String, fatal: bool },
}

impl RecorderState {
    pub fn label(&self) -> &'static str {
        match self {
            RecorderState::Idle => "idle",
            RecorderState::Countdown { .. } => "countdown",
            RecorderState::Recording => "recording",
            RecorderState::Paused => "paused",
            RecorderState::Finalizing => "finalizing",
            RecorderState::Error { .. } => "error",
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self,
            RecorderState::Countdown { .. }
                | RecorderState::Recording
                | RecorderState::Paused
                | RecorderState::Finalizing
        )
    }
}

/// Events emitted Rust → frontend during a recording. Serialized to the
/// `recorder://…` event channel; the frontend store is a projection of these.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecorderEvent {
    StateChanged { state: RecorderState },
    Elapsed { seconds: f64 },
    /// Input meter level in dBFS for the popover mic meter (future: real values).
    #[allow(dead_code)]
    Level { mic_db: f32 },
    Error { message: String, fatal: bool },
    /// Capture producer vanished (window closed, display unplugged, etc.).
    Interrupted { frames_encoded: u64 },
}

impl RecorderEvent {
    /// The Tauri event name this variant is emitted under.
    pub fn channel(&self) -> &'static str {
        match self {
            RecorderEvent::StateChanged { .. } => "recorder://state-changed",
            RecorderEvent::Elapsed { .. } => "recorder://elapsed",
            RecorderEvent::Level { .. } => "recorder://level",
            RecorderEvent::Error { .. } => "recorder://error",
            RecorderEvent::Interrupted { .. } => "recorder://interrupted",
        }
    }
}

/// Stats recorded into `meta.json`, invaluable for debugging user reports.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    pub frames_encoded: u64,
    pub frames_dropped: u64,
    pub duration_seconds: f64,
}

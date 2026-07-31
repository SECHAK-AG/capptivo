//! What this build/OS combination can actually do. The frontend reads this once
//! at boot and feature-gates UI from it, instead of scattering platform sniffs —
//! every honest per-platform degradation (Wayland hotkeys, Linux portal picker,
//! …) hangs off exactly one of these flags.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    /// "macos" | "windows" | "linux".
    pub os: &'static str,
    /// Displays/windows can be listed with thumbnails for our own picker.
    /// False on Linux, where the desktop portal owns source selection.
    pub can_enumerate_sources: bool,
    /// The drag-a-region area picker is available.
    pub can_pick_area: bool,
    /// Global cursor position/clicks can be sampled for cursor replay and
    /// zoom-follow. On Wayland this uses portal Metadata when available.
    pub can_track_cursor: bool,
    /// System (desktop) audio can be captured alongside the screen.
    pub can_capture_system_audio: bool,
    /// Capptivo's own overlay chrome (camera bubble, HUD) can be excluded from
    /// the recorded frames. False on Linux — the portal captures everything.
    pub can_exclude_overlays: bool,
    /// The Alt+Shift+R global shortcut can be registered. False on Wayland.
    pub has_global_shortcut: bool,
    /// Granting screen-recording permission requires an app restart (macOS TCC).
    pub needs_restart_after_permission: bool,
    /// A connected iPhone / iPad's own screen can be recorded over USB. macOS
    /// only — it rides CoreMediaIO, which has no Windows or Linux equivalent.
    pub can_capture_device: bool,
}

impl PlatformCapabilities {
    pub fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self {
                os: "macos",
                can_enumerate_sources: true,
                can_pick_area: true,
                can_track_cursor: true,
                can_capture_system_audio: true,
                can_exclude_overlays: true,
                has_global_shortcut: true,
                needs_restart_after_permission: true,
                can_capture_device: true,
            }
        }
        #[cfg(target_os = "windows")]
        {
            Self {
                os: "windows",
                can_enumerate_sources: true,
                can_pick_area: true,
                can_track_cursor: true,
                can_capture_system_audio: true,
                can_exclude_overlays: true,
                has_global_shortcut: true,
                needs_restart_after_permission: false,
                can_capture_device: false,
            }
        }
        #[cfg(target_os = "linux")]
        {
            let wayland = is_wayland();
            Self {
                os: "linux",
                // The portal dialog is the picker on both X11 and Wayland.
                can_enumerate_sources: false,
                // Region selection over a portal-owned capture isn't reliable;
                // crop lives in the editor instead (v1).
                can_pick_area: false,
                // X11: global pointer probe. Wayland: PipeWire SPA_META_Cursor
                // when the portal advertises Metadata (else empty track).
                can_track_cursor: true,
                can_capture_system_audio: true,
                can_exclude_overlays: false,
                has_global_shortcut: !wayland,
                needs_restart_after_permission: false,
                can_capture_device: false,
            }
        }
    }
}

/// Whether the current Linux session is Wayland. `XDG_SESSION_TYPE` is the
/// canonical signal; `WAYLAND_DISPLAY` covers sessions that don't set it.
#[cfg(target_os = "linux")]
pub fn is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE")
        .map(|t| t.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

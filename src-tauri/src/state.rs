//! Application state managed by Tauri and shared across commands.

use crate::export_h264::H264StreamMuxer;
use crate::export_rawvideo::RawvideoStreamEncoder;
use crate::project::ProjectStore;
use crate::recorder::backend::{CaptureBackend, TestPatternBackend};
use crate::recorder::types::{RecorderConfig, RecorderEvent};
use crate::recorder::RecorderController;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub struct AppState {
    pub recorder: Arc<RecorderController>,
    pub store: Arc<ProjectStore>,
    /// The recording currently being captured (set on start, cleared on stop).
    /// Holds the config so `stop_recording` can finalize the project manifest.
    pub current_project: Mutex<Option<CurrentProject>>,
    /// Open export file sinks, keyed by handle id (see `commands::export`).
    pub exports: Mutex<HashMap<u64, ExportSink>>,
    /// Annex-B H.264 → ffmpeg MP4 sessions (see `commands::export` h264 stream).
    pub h264_exports: Mutex<HashMap<u64, H264StreamMuxer>>,
    /// Pixi RGBA → ffmpeg encode sessions (Windows Path B; see rawvideo stream).
    pub rawvideo_exports: Mutex<HashMap<u64, RawvideoStreamEncoder>>,
    pub next_export_id: Mutex<u64>,
    /// Optional face-cam file being written by the camera WebView during capture.
    pub camera_sink: Mutex<Option<ExportSink>>,
    /// Project ids with a preview-proxy transcode in flight, so concurrent
    /// `ensure_proxy` calls coalesce to a single FFmpeg pass.
    pub proxy_jobs: Mutex<HashSet<String>>,
    /// Same coalescing for the face-cam normalization pass (`ensure_camera_track`).
    pub camera_jobs: Mutex<HashSet<String>>,
    pub pending_export_paths: Mutex<HashSet<PathBuf>>,
}

pub struct ExportSink {
    pub file: File,
    /// Bytes are written here — a temp sidecar during editor export, or the
    /// final path for in-flight capture sinks (mic / camera).
    pub path: PathBuf,
    /// User-chosen export destination. On `finish`, `path` is renamed here.
    pub final_path: Option<PathBuf>,
}

#[derive(Clone)]
pub struct CurrentProject {
    pub id: String,
    pub config: RecorderConfig,
}

impl AppState {
    /// Build state from an app handle: resolves the data dir for the project
    /// store and wires the recorder's event `emit` closure to Tauri events.
    pub fn build(app: &AppHandle) -> Self {
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("Capptivo"));
        let store = Arc::new(ProjectStore::new(data_dir));

        let emit_handle = app.clone();
        let emit = Arc::new(move |event: RecorderEvent| {
            // Swap tray items on state changes only — never on elapsed ticks.
            if let RecorderEvent::StateChanged { ref state } = event {
                crate::tray::sync_for_state(&emit_handle, state);
            }
            let channel = event.channel();
            if let Err(err) = emit_handle.emit(channel, &event) {
                tracing::warn!(%channel, %err, "failed to emit recorder event");
            }
        });

        let recorder = Arc::new(RecorderController::new(make_backend(app), emit));

        Self {
            recorder,
            store,
            current_project: Mutex::new(None),
            exports: Mutex::new(HashMap::new()),
            h264_exports: Mutex::new(HashMap::new()),
            rawvideo_exports: Mutex::new(HashMap::new()),
            next_export_id: Mutex::new(1),
            camera_sink: Mutex::new(None),
            proxy_jobs: Mutex::new(HashSet::new()),
            camera_jobs: Mutex::new(HashSet::new()),
            pending_export_paths: Mutex::new(HashSet::new()),
        }
    }
}

/// Choose the capture backend for this OS: ScreenCaptureKit on macOS,
/// Windows.Graphics.Capture on Windows, the xdg-desktop-portal + PipeWire path
/// on Linux. Falls back to the synthetic test pattern when capture isn't
/// supported (old OS, CI, no portal) so the app still boots and the UI is usable.
fn make_backend(app: &AppHandle) -> Box<dyn CaptureBackend> {
    // macOS additionally routes `device:` sources to CoreMediaIO/AVFoundation for
    // iPhone & iPad screen capture — a different framework with different
    // permissions, so it is composed in rather than folded into the screen
    // backend. See `backend/router.rs`.
    #[cfg(target_os = "macos")]
    {
        use crate::recorder::backend::{AvfDeviceBackend, RoutingBackend, DEVICE_ID_PREFIX};
        let device = Box::new(AvfDeviceBackend::new());
        return Box::new(RoutingBackend::new(
            make_screen_backend(app),
            device,
            DEVICE_ID_PREFIX,
        ));
    }
    #[cfg(not(target_os = "macos"))]
    make_screen_backend(app)
}

/// The display/window backend for this OS.
///
/// `app` is only read on macOS (SCK overlay CGWindowIDs). Other targets keep the
/// same signature so the call sites stay identical across platforms.
#[allow(unused_variables)]
fn make_screen_backend(app: &AppHandle) -> Box<dyn CaptureBackend> {
    #[cfg(all(target_os = "macos", feature = "scap-capture"))]
    {
        use crate::recorder::backend::ScapBackend;
        let scap = ScapBackend::new(app.clone());
        if scap.is_supported() {
            tracing::info!("using ScreenCaptureKit capture backend");
            return Box::new(scap);
        }
        tracing::warn!("ScreenCaptureKit unsupported — falling back to test pattern");
    }
    #[cfg(all(target_os = "windows", feature = "wgc-capture"))]
    {
        use crate::recorder::backend::WgcBackend;
        let wgc = WgcBackend::new();
        if wgc.is_supported() {
            tracing::info!("using Windows.Graphics.Capture backend");
            return Box::new(wgc);
        }
        tracing::warn!("Windows.Graphics.Capture unsupported — falling back to test pattern");
    }
    #[cfg(all(target_os = "linux", feature = "portal-capture"))]
    {
        use crate::recorder::backend::PortalBackend;
        let portal = PortalBackend::new();
        if portal.is_supported() {
            tracing::info!("using xdg-desktop-portal capture backend");
            return Box::new(portal);
        }
        tracing::warn!("screen-cast portal unavailable — falling back to test pattern");
    }
    Box::new(TestPatternBackend::default())
}

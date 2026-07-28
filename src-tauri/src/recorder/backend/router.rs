//! Composes the screen backend with the device backend behind one
//! [`CaptureBackend`].
//!
//! Screen capture and device capture are unrelated subsystems — ScreenCaptureKit
//! versus CoreMediaIO/AVFoundation, screen-recording TCC versus camera TCC — and
//! neither should learn about the other. Routing on the `source_id` prefix keeps
//! the seam described in `backend/mod.rs` intact: [`RecorderController`] still
//! holds exactly one `Box<dyn CaptureBackend>`.
//!
//! [`RecorderController`]: crate::recorder::RecorderController

use super::{CaptureBackend, CaptureHandle};
use crate::error::AppResult;
use crate::recorder::types::{CaptureDevice, CaptureSource, RecorderConfig};

pub struct RoutingBackend {
    screen: Box<dyn CaptureBackend>,
    device: Box<dyn CaptureBackend>,
    device_prefix: &'static str,
}

impl RoutingBackend {
    pub fn new(
        screen: Box<dyn CaptureBackend>,
        device: Box<dyn CaptureBackend>,
        device_prefix: &'static str,
    ) -> Self {
        Self {
            screen,
            device,
            device_prefix,
        }
    }

    fn backend_for(&self, source_id: &str) -> &dyn CaptureBackend {
        if source_id.starts_with(self.device_prefix) {
            &*self.device
        } else {
            &*self.screen
        }
    }
}

impl CaptureBackend for RoutingBackend {
    // Support and permission questions are about *screen* capture — that is what
    // gates the Record button and the permissions card. Device capture carries
    // its own camera-permission story, surfaced through `list_devices`.
    fn is_supported(&self) -> bool {
        self.screen.is_supported()
    }

    fn has_permission(&self) -> bool {
        self.screen.has_permission()
    }

    fn request_permission(&self) -> bool {
        self.screen.request_permission()
    }

    fn list_sources(&self) -> AppResult<Vec<CaptureSource>> {
        self.screen.list_sources()
    }

    fn list_devices(&self) -> AppResult<Vec<CaptureDevice>> {
        self.device.list_devices()
    }

    fn start(&self, config: &RecorderConfig) -> AppResult<CaptureHandle> {
        self.backend_for(&config.source_id).start(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recorder::backend::TestPatternBackend;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Records which backend `start` landed on.
    struct Spy {
        started: Arc<AtomicUsize>,
    }

    impl CaptureBackend for Spy {
        fn is_supported(&self) -> bool {
            true
        }
        fn has_permission(&self) -> bool {
            true
        }
        fn request_permission(&self) -> bool {
            true
        }
        fn list_sources(&self) -> AppResult<Vec<CaptureSource>> {
            Ok(Vec::new())
        }
        fn list_devices(&self) -> AppResult<Vec<CaptureDevice>> {
            Ok(vec![CaptureDevice {
                id: "device:abc".into(),
                name: "iPhone".into(),
                model: None,
                width: 0,
                height: 0,
                has_audio: true,
            }])
        }
        fn start(&self, _config: &RecorderConfig) -> AppResult<CaptureHandle> {
            self.started.fetch_add(1, Ordering::Relaxed);
            Err(crate::error::AppError::Unsupported)
        }
    }

    fn config(source_id: &str) -> RecorderConfig {
        RecorderConfig {
            source_id: source_id.into(),
            crop: None,
            fps: 30,
            show_cursor: true,
            capture_system_audio: false,
            capture_microphone: false,
            quality: Default::default(),
        }
    }

    fn router(started: Arc<AtomicUsize>) -> RoutingBackend {
        RoutingBackend::new(
            Box::new(TestPatternBackend::default()),
            Box::new(Spy { started }),
            "device:",
        )
    }

    #[test]
    fn device_ids_route_to_the_device_backend() {
        let started = Arc::new(AtomicUsize::new(0));
        let router = router(started.clone());
        let _ = router.start(&config("device:00008120-001"));
        assert_eq!(started.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn screen_ids_route_to_the_screen_backend() {
        let started = Arc::new(AtomicUsize::new(0));
        let router = router(started.clone());
        let _ = router.start(&config("display:1"));
        let _ = router.start(&config("window:42"));
        assert_eq!(started.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn devices_come_from_the_device_backend_and_sources_from_the_screen_one() {
        let router = router(Arc::new(AtomicUsize::new(0)));
        assert_eq!(router.list_devices().unwrap().len(), 1);
        // TestPatternBackend advertises a synthetic display, never a device.
        assert!(router
            .list_sources()
            .unwrap()
            .iter()
            .all(|s| !s.id.starts_with("device:")));
    }
}

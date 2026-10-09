//! Timeline time → face-cam media time (`lib/faceCamSync.ts`).
//!
//! `offset_ms = cameraStart − screenStart`. The camera starts a beat after the
//! screen and stops a beat before it; both gaps hold one pinned frame.

/// Kept a hair inside the file: a decoder has no frame at exactly 0 or EOF.
const EDGE_EPSILON: f64 = 0.001;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FaceCamFrame {
    /// No usable duration: draw no face-cam.
    Before,
    /// Inside the recorded span.
    Active(f64),
    /// Outside the span on either side: draw this pinned frame.
    Hold(f64),
}

impl FaceCamFrame {
    pub fn media_time(self) -> Option<f64> {
        match self {
            Self::Before => None,
            Self::Active(t) | Self::Hold(t) => Some(t),
        }
    }
}

/// `faceCamFrameAt`.
pub fn face_cam_frame_at(
    timeline_time: f64,
    offset_ms: Option<f64>,
    cam_duration: f64,
) -> FaceCamFrame {
    // Negated on purpose: a NaN duration means "no usable duration".
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    let unusable = !(cam_duration > 0.0) || !timeline_time.is_finite();
    if unusable {
        return FaceCamFrame::Before;
    }
    let offset_sec = offset_ms
        .filter(|o| o.is_finite())
        .map_or(0.0, |o| o / 1000.0);
    let shifted = timeline_time - offset_sec;
    let last_frame = (cam_duration - EDGE_EPSILON).max(0.0);
    if shifted >= last_frame {
        return FaceCamFrame::Hold(last_frame);
    }
    if shifted < 0.0 {
        return FaceCamFrame::Hold(EDGE_EPSILON);
    }
    FaceCamFrame::Active(shifted.min(last_frame).max(EDGE_EPSILON))
}

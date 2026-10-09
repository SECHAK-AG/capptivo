//! Trim segments and the export frame clock.

use crate::document::TrimSegment;
use crate::math::{js_max, js_min, js_round};

/// One segment covering the whole recording, or none when it is empty
/// (`createFullSegment`).
pub fn full_segment(duration: f64) -> Vec<TrimSegment> {
    let duration = js_max(0.0, duration);
    if duration <= 0.0 || duration.is_nan() {
        return Vec::new();
    }
    vec![TrimSegment {
        id: "full".into(),
        start: 0.0,
        end: duration,
    }]
}

/// Seconds of the recording that survive the trims (`totalKeptDuration`).
pub fn total_kept_duration(segments: &[TrimSegment]) -> f64 {
    segments.iter().map(|s| js_max(0.0, s.end - s.start)).sum()
}

/// The deterministic frame clock: one *source* time per output frame, ascending
/// across the kept segments (`planFrameTimes`).
///
/// Samples the centre of each `1/fps` slot, never its leading edge: exact `t=0`
/// often has no decodable sample yet, and the centre is what a primed seek
/// paints for the first frame.
pub fn plan_frame_times(segments: &[TrimSegment], fps: f64) -> Vec<f64> {
    let slot = 1.0 / js_max(1.0, fps);
    let mut times = Vec::new();
    for seg in segments {
        let duration = js_max(0.0, seg.end - seg.start);
        let frame_count = js_max(1.0, js_round(duration * fps)) as usize;
        times.reserve(frame_count);
        for i in 0..frame_count {
            times.push(js_min(seg.end - 1e-4, seg.start + (i as f64 + 0.5) * slot));
        }
    }
    times
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64) -> TrimSegment {
        TrimSegment {
            id: String::new(),
            start,
            end,
        }
    }

    #[test]
    fn plans_slot_centres_per_segment() {
        let times = plan_frame_times(&[seg(0.0, 1.0), seg(2.0, 2.1)], 10.0);
        assert_eq!(times.len(), 11);
        assert!((times[0] - 0.05).abs() < 1e-12);
        assert!((times[9] - 0.95).abs() < 1e-12);
        // A 0.1 s segment still gets its one frame, pulled inside its end.
        assert!((times[10] - 2.05).abs() < 1e-12);
    }

    #[test]
    fn short_segment_never_samples_past_its_end() {
        let times = plan_frame_times(&[seg(3.0, 3.001)], 60.0);
        assert_eq!(times.len(), 1);
        assert!(times[0] <= 3.001 - 1e-4 + 1e-12);
    }

    #[test]
    fn matches_logged_export_frame_count() {
        // The 2026-08-24 take: 75.767 s at 60 fps → 4546 frames in the log.
        assert_eq!(plan_frame_times(&[seg(0.0, 75.767)], 60.0).len(), 4546);
    }
}

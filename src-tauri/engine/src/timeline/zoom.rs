//! Zoom motion: the camera scale/focus over time.
//!
//! Ported from `engine/zoomMotion.ts`, `engine/smartFollowCursor.ts`,
//! `engine/cameraTransform.ts` and the editor's `lib/zoomCache.ts`. Each
//! fragment is integrated once at [`ZOOM_MOTION_SAMPLE_FPS`] into keyframes and
//! sampled by interpolation, so a frame's zoom is a pure function of its time —
//! preview and export cannot disagree about where the camera is.

use crate::document::{CropNorm, RecordingMetadata, ZoomFragment, ZoomMode};
use crate::math::{clamp, js_max, js_min, Rect};

/// Offline integration rate for zoom keyframes.
pub const ZOOM_MOTION_SAMPLE_FPS: f64 = 120.0;

const FOLLOW_CENTER_TAU_SEC: f64 = 0.55;
const FOLLOW_SPRING_ZETA: f64 = 1.05;
const FOLLOW_MAX_VELOCITY: f64 = 3.4;

const DEFAULT_FACE_CAM_ZOOM_PRESENCE_SCALE: f64 = 0.62;
const MIN_FACE_CAM_ZOOM_PRESENCE_SCALE: f64 = 0.35;
const MAX_FACE_CAM_ZOOM_PRESENCE_SCALE: f64 = 1.0;

/// Smart-follow tuning (`SMART_FOLLOW_CONFIG`).
const SAFE_ZONE_INNER_FRACTION: f64 = 0.5;
const CLICK_HOLD_SEC: f64 = 0.4;
const FOLLOW_PAN_SNAP_EPS: f64 = 2e-5;
const FOLLOW_VELOCITY_SNAP_EPS: f64 = 0.028;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const CENTER: Vec2 = Vec2 { x: 0.5, y: 0.5 };

    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// One integrated zoom sample.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZoomKeyframe {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct MotionState {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
}

/// Default true: the face-cam shrinks during a zoom unless turned off.
pub fn shrinks_face_cam(fragment: &ZoomFragment) -> bool {
    fragment.shrink_face_cam_during_zoom != Some(false)
}

/// Face-cam scale at full zoom (`getFaceCamZoomPresenceMinScale`).
pub fn face_cam_presence_min_scale(fragment: &ZoomFragment) -> f64 {
    match fragment.face_cam_zoom_presence_scale {
        Some(raw) if raw.is_finite() => clamp(
            raw,
            MIN_FACE_CAM_ZOOM_PRESENCE_SCALE,
            MAX_FACE_CAM_ZOOM_PRESENCE_SCALE,
        ),
        _ => DEFAULT_FACE_CAM_ZOOM_PRESENCE_SCALE,
    }
}

fn scale_from_fixed_rect(rect: &CropNorm) -> f64 {
    let max_side = js_max(1e-6, js_max(rect.width, rect.height));
    clamp(1.0 / max_side, 1.0, 3.0)
}

/// The first fragment covering `time`, in creation order — overlapping
/// fragments resolve exactly like the editor's `Array.find`.
pub fn find_active_fragment(
    fragments: &[ZoomFragment],
    time: f64,
) -> Option<(usize, &ZoomFragment)> {
    fragments
        .iter()
        .enumerate()
        .find(|(_, f)| time >= f.start && time <= f.end)
}

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - clamp(t, 0.0, 1.0)).powi(3)
}

/// 0 → 1 → 0 zoom-in / plateau / zoom-out envelope (`computeZoomEnvelope`).
pub fn zoom_envelope(fragment: &ZoomFragment, time: f64) -> f64 {
    let total = js_max(1e-6, fragment.end - fragment.start);
    let local = clamp(time - fragment.start, 0.0, total);
    let ease_in = clamp(fragment.ease_in, 0.0, total / 2.0);
    let ease_out = clamp(fragment.ease_out, 0.0, total / 2.0);
    if ease_in > 0.0 && local < ease_in {
        return ease_out_cubic(local / ease_in);
    }
    if ease_out > 0.0 && local > total - ease_out {
        let progress = clamp((local - (total - ease_out)) / ease_out, 0.0, 1.0);
        return 1.0 - ease_out_cubic(progress);
    }
    1.0
}

/// Keep the zoom centre inside the visible frame at `scale`
/// (`clampTargetForScale`).
pub fn clamp_target_for_scale(target: Vec2, scale: f64) -> Vec2 {
    let safe_scale = js_max(1.0, scale);
    let half_visible = 0.5 / safe_scale;
    let min_center = half_visible;
    let max_center = 1.0 - half_visible;
    if min_center >= max_center - 1e-9 {
        return Vec2::CENTER;
    }
    Vec2::new(
        clamp(target.x, min_center, max_center),
        clamp(target.y, min_center, max_center),
    )
}

fn scene_zoom_target_scale(fragment: &ZoomFragment) -> f64 {
    match (fragment.mode, fragment.fixed_rect.as_ref()) {
        (ZoomMode::FixedRect, Some(rect)) => scale_from_fixed_rect(rect),
        _ => js_max(1.0, fragment.target_scale),
    }
}

/// Render scale: hyperbolic for fixed-rect, linear for follow-cursor.
fn scene_zoom_scale(fragment: &ZoomFragment, envelope: f64) -> f64 {
    let env = if envelope.is_finite() {
        clamp(envelope, 0.0, 1.0)
    } else {
        0.0
    };
    let s = js_max(1.0, scene_zoom_target_scale(fragment));
    if s - 1.0 < 1e-6 || env <= 0.0 {
        return 1.0;
    }
    if fragment.mode == ZoomMode::FixedRect {
        return s / js_max(1e-6, s - (s - 1.0) * env);
    }
    1.0 + (s - 1.0) * env
}

fn scene_zoom_render_center(
    fragment: &ZoomFragment,
    pan: Vec2,
    zoom_scale: f64,
    envelope: f64,
) -> Vec2 {
    let s = js_max(1.0, zoom_scale);
    let env = if envelope.is_finite() {
        clamp(envelope, 0.0, 1.0)
    } else {
        0.0
    };
    if env <= 1e-9 || s <= 1.0 + 1e-6 {
        return Vec2::CENTER;
    }
    if fragment.mode == ZoomMode::FixedRect {
        // Focus may land on composition padding (outside recording 0–1).
        return Vec2::new(0.5 + (pan.x - 0.5) * env, 0.5 + (pan.y - 0.5) * env);
    }
    clamp_target_for_scale(pan, s)
}

fn follow_center_tau_seconds(fragment: &ZoomFragment) -> f64 {
    let raw = fragment.damping;
    let mut d = if raw.is_finite() { raw } else { 4.0 };
    if d < 1.0 {
        d = 4.0;
    }
    d = clamp(d, 1.0, 20.0);
    FOLLOW_CENTER_TAU_SEC * (d / 4.0)
}

fn follow_spring_stiffness(fragment: &ZoomFragment) -> f64 {
    let tau = follow_center_tau_seconds(fragment);
    clamp(2.95 / js_max(tau, 0.065), 4.2, 30.0)
}

/// Full-file NDC → crop NDC, clamped (`createFullNormToContentNdcFromCrop`).
fn full_norm_to_content(crop: Option<CropNorm>, p: Vec2) -> Vec2 {
    match crop {
        None => p,
        Some(c) => {
            let w = js_max(1e-9, c.width);
            let h = js_max(1e-9, c.height);
            Vec2::new(
                clamp((p.x - c.x) / w, 0.0, 1.0),
                clamp((p.y - c.y) / h, 0.0, 1.0),
            )
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct TimedPoint {
    t: f64,
    x: f64,
    y: f64,
}

/// Cursor + click track mapped into crop space around one fragment.
struct SmartFollowPlanner {
    samples: Vec<TimedPoint>,
    clicks: Vec<TimedPoint>,
}

/// First index with `t >= time`.
fn lower_bound_by_time<T>(items: &[T], time: f64, t: impl Fn(&T) -> f64) -> usize {
    items.partition_point(|item| t(item) < time)
}

impl SmartFollowPlanner {
    fn new(
        metadata: Option<&RecordingMetadata>,
        fragment: &ZoomFragment,
        crop: Option<CropNorm>,
    ) -> Option<Self> {
        let metadata = metadata?;
        let raw = &metadata.cursor_samples;
        if raw.is_empty() {
            return None;
        }
        let pad = CLICK_HOLD_SEC + 0.25;
        let range_start = fragment.start - pad;
        let range_end = fragment.end + pad;
        let map = |x: f64, y: f64| {
            let m = full_norm_to_content(crop, Vec2::new(x, y));
            (clamp(m.x, 0.0, 1.0), clamp(m.y, 0.0, 1.0))
        };

        let mut samples = Vec::new();
        for sample in &raw[lower_bound_by_time(raw, range_start, |s| s.t)..] {
            if sample.t > range_end {
                break;
            }
            let (x, y) = map(sample.x, sample.y);
            samples.push(TimedPoint { t: sample.t, x, y });
        }
        if samples.is_empty() {
            let index = lower_bound_by_time(raw, fragment.start, |s| s.t);
            let fallback = raw.get(index).unwrap_or(&raw[raw.len() - 1]);
            let (x, y) = map(fallback.x, fallback.y);
            samples.push(TimedPoint {
                t: fragment.start,
                x,
                y,
            });
        }

        let mut clicks: Vec<TimedPoint> = metadata
            .cursor_click_samples
            .iter()
            .filter(|c| c.t >= range_start && c.t <= range_end)
            .map(|c| {
                let (x, y) = map(c.x, c.y);
                TimedPoint { t: c.t, x, y }
            })
            .collect();
        // Stable, like `Array.prototype.sort`.
        clicks.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
        Some(Self { samples, clicks })
    }

    /// Linear interpolation over the mapped track (`sampleMappedPointsAtTime`).
    fn sample(&self, time: f64) -> Option<Vec2> {
        let samples = &self.samples;
        let first = samples.first()?;
        let last = samples[samples.len() - 1];
        if time <= first.t {
            return Some(Vec2::new(first.x, first.y));
        }
        if time >= last.t {
            return Some(Vec2::new(last.x, last.y));
        }
        let (mut lo, mut hi) = (0usize, samples.len() - 1);
        while lo + 1 < hi {
            let mid = (lo + hi) >> 1;
            if samples[mid].t <= time {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let a = samples[lo];
        let b = samples[hi];
        let span = js_max(1e-9, b.t - a.t);
        let p = (time - a.t) / span;
        Some(Vec2::new(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p))
    }

    fn active_click(&self, time: f64) -> Option<TimedPoint> {
        for click in self.clicks.iter().rev() {
            let elapsed = time - click.t;
            if elapsed < 0.0 {
                continue;
            }
            if elapsed <= CLICK_HOLD_SEC {
                return Some(*click);
            }
            break;
        }
        None
    }
}

/// Shift focus on an axis only once the cursor leaves the inner safe zone
/// (`recenterFocusWhenCursorLeavesSafeZone`).
fn recenter_focus(current: Vec2, cursor: Vec2, scale: f64) -> Vec2 {
    let safe_scale = js_max(1.0, scale);
    let half_visible = 0.5 / safe_scale;
    let safe_half = half_visible * clamp(SAFE_ZONE_INNER_FRACTION, 0.2, 0.95);
    let mut next = current;
    if cursor.x < current.x - safe_half || cursor.x > current.x + safe_half {
        next.x = cursor.x;
    }
    if cursor.y < current.y - safe_half || cursor.y > current.y + safe_half {
        next.y = cursor.y;
    }
    clamp_target_for_scale(next, scale)
}

/// Overdamped spring step with overshoot snapping (smartFollow's
/// `stepSpringMotion`).
fn step_spring_motion(
    state: MotionState,
    target: Vec2,
    dt: f64,
    stiffness: f64,
    zeta: f64,
    max_velocity: f64,
) -> MotionState {
    let safe_dt = js_max(1e-6, js_min(dt, 0.05));
    let omega = stiffness;
    let dx = target.x - state.x;
    let dy = target.y - state.y;
    let ax = omega * omega * dx - 2.0 * zeta * omega * state.vx;
    let ay = omega * omega * dy - 2.0 * zeta * omega * state.vy;
    let mut vx = clamp(state.vx + ax * safe_dt, -max_velocity, max_velocity);
    let mut vy = clamp(state.vy + ay * safe_dt, -max_velocity, max_velocity);
    let mut x = clamp(state.x + vx * safe_dt, 0.0, 1.0);
    let mut y = clamp(state.y + vy * safe_dt, 0.0, 1.0);
    if zeta >= 1.0 {
        if (state.x <= target.x && x > target.x) || (state.x >= target.x && x < target.x) {
            x = target.x;
            vx = 0.0;
        }
        if (state.y <= target.y && y > target.y) || (state.y >= target.y && y < target.y) {
            y = target.y;
            vy = 0.0;
        }
    }
    MotionState { x, y, vx, vy }
}

/// Follow-cursor stepping: `stepSmartFollowCursor` and its runtime state.
struct SmartFollow {
    planner: SmartFollowPlanner,
    /// Logical focus the safe zone is measured from — not the spring's pan.
    committed: Vec2,
    dt: f64,
    stiffness: f64,
}

impl SmartFollow {
    /// One plateau step.
    fn step(&mut self, motion: MotionState, cursor: Vec2, time: f64, scale: f64) -> MotionState {
        let click = self.planner.active_click(time);
        let pan_target = match click {
            Some(c) => clamp_target_for_scale(Vec2::new(c.x, c.y), scale),
            None => recenter_focus(self.committed, cursor, scale),
        };
        self.committed = pan_target;
        let stiffness = if click.is_some() {
            self.stiffness * 1.35
        } else {
            self.stiffness
        };
        step_follow_spring(motion, pan_target, self.dt, stiffness, scale)
    }
}

/// The spring half of a follow step, with snapping and the visible-area clamp.
fn step_follow_spring(
    motion: MotionState,
    pan_target: Vec2,
    dt: f64,
    stiffness: f64,
    scale: f64,
) -> MotionState {
    let mut next = step_spring_motion(
        motion,
        pan_target,
        dt,
        stiffness,
        FOLLOW_SPRING_ZETA,
        FOLLOW_MAX_VELOCITY,
    );
    if (pan_target.x - next.x).hypot(pan_target.y - next.y) < FOLLOW_PAN_SNAP_EPS
        && next.vx.hypot(next.vy) < FOLLOW_VELOCITY_SNAP_EPS
    {
        next = MotionState {
            x: pan_target.x,
            y: pan_target.y,
            vx: 0.0,
            vy: 0.0,
        };
    }
    let c = clamp_target_for_scale(Vec2::new(next.x, next.y), scale);
    MotionState {
        x: c.x,
        y: c.y,
        vx: next.vx,
        vy: next.vy,
    }
}

/// Integrate one fragment into keyframes (`computeZoomKeyframes`).
///
/// `crop` maps cursor positions into the user's content crop; `recording` is
/// the recording rect as stage fractions, used to map fixed-rect centres
/// (authored in stage space) into recording space.
pub fn compute_zoom_keyframes(
    fragment: &ZoomFragment,
    metadata: Option<&RecordingMetadata>,
    fps: f64,
    crop: Option<CropNorm>,
    recording: Option<Rect>,
) -> Vec<ZoomKeyframe> {
    let duration = fragment.end - fragment.start;
    // `for (i = 0; i <= ceil(duration * fps); …)` — no samples at all when the
    // bound is negative or NaN.
    let last_index = (duration * fps).ceil();
    let sample_count = if last_index >= 0.0 {
        last_index as usize + 1
    } else {
        0
    };
    let mut keyframes = Vec::with_capacity(sample_count);

    let mut motion = MotionState {
        x: 0.5,
        y: 0.5,
        vx: 0.0,
        vy: 0.0,
    };
    let dt = 1.0 / js_max(1.0, fps);
    let mut follow = if fragment.mode == ZoomMode::FollowCursor {
        SmartFollowPlanner::new(metadata, fragment, crop).map(|planner| SmartFollow {
            planner,
            committed: Vec2::new(motion.x, motion.y),
            dt,
            stiffness: follow_spring_stiffness(fragment),
        })
    } else {
        None
    };
    let mut ease_out_anchor: Option<Vec2> = None;
    let ease_in_seed = follow
        .as_ref()
        .and_then(|f| f.planner.sample(fragment.start));

    let total_duration = js_max(1e-6, fragment.end - fragment.start);
    let safe_ease_out = clamp(fragment.ease_out, 0.0, total_duration / 2.0);
    let ease_out_start_t = if safe_ease_out > 0.0 {
        fragment.end - safe_ease_out
    } else {
        fragment.end
    };
    let full_scale = js_max(1.0, fragment.target_scale);

    for i in 0..sample_count {
        let t = fragment.start + i as f64 / fps;
        let envelope = zoom_envelope(fragment, t);
        let zoom_scale = if fragment.mode == ZoomMode::FixedRect {
            scene_zoom_scale(fragment, envelope)
        } else {
            1.0 + (full_scale - 1.0) * envelope
        };
        let in_ease_out = safe_ease_out > 0.0 && t > ease_out_start_t && envelope < 1.0;

        let cursor = follow.as_ref().and_then(|f| f.planner.sample(t));

        match (fragment.mode, cursor, follow.as_mut(), fragment.fixed_rect) {
            (ZoomMode::FollowCursor, Some(cursor), Some(follow), _) => {
                if in_ease_out {
                    let anchor = *ease_out_anchor.get_or_insert(Vec2::new(motion.x, motion.y));
                    let interp = Vec2::new(
                        0.5 + (anchor.x - 0.5) * envelope,
                        0.5 + (anchor.y - 0.5) * envelope,
                    );
                    let panned = clamp_target_for_scale(interp, zoom_scale);
                    motion = MotionState {
                        x: panned.x,
                        y: panned.y,
                        vx: 0.0,
                        vy: 0.0,
                    };
                    follow.committed = panned;
                } else if envelope < 1.0 {
                    // Zoom-in holds focus on the start seed; only scale eases.
                    let seed = ease_in_seed.unwrap_or(cursor);
                    let focus = clamp_target_for_scale(seed, full_scale);
                    motion = MotionState {
                        x: focus.x,
                        y: focus.y,
                        vx: 0.0,
                        vy: 0.0,
                    };
                    follow.committed = focus;
                } else {
                    motion = follow.step(motion, cursor, t, zoom_scale);
                }
            }
            (ZoomMode::FixedRect, _, _, Some(rect)) => {
                let stage_center = Vec2::new(rect.x + rect.width / 2.0, rect.y + rect.height / 2.0);
                let mapped = match recording {
                    Some(video) => Vec2::new(
                        (stage_center.x - video.x) / js_max(1e-6, video.width),
                        (stage_center.y - video.y) / js_max(1e-6, video.height),
                    ),
                    None => stage_center,
                };
                let fixed_center = full_norm_to_content(crop, mapped);
                let panned = scene_zoom_render_center(fragment, fixed_center, zoom_scale, envelope);
                motion = MotionState {
                    x: panned.x,
                    y: panned.y,
                    vx: 0.0,
                    vy: 0.0,
                };
            }
            _ => {}
        }

        let safe = if fragment.mode == ZoomMode::FixedRect {
            Vec2::new(motion.x, motion.y)
        } else {
            let clamp_scale = if envelope < 1.0 && !in_ease_out {
                full_scale
            } else {
                zoom_scale
            };
            clamp_target_for_scale(Vec2::new(motion.x, motion.y), clamp_scale)
        };
        motion.x = safe.x;
        motion.y = safe.y;
        keyframes.push(ZoomKeyframe {
            t,
            x: safe.x,
            y: safe.y,
            scale: zoom_scale,
        });
    }
    keyframes
}

/// Linear interpolation between keyframes (`interpolateZoomKeyframe`).
pub fn interpolate_zoom_keyframe(keyframes: &[ZoomKeyframe], time: f64) -> ZoomKeyframe {
    let Some(first) = keyframes.first() else {
        return ZoomKeyframe {
            t: time,
            x: 0.5,
            y: 0.5,
            scale: 1.0,
        };
    };
    if time <= first.t {
        return ZoomKeyframe { t: time, ..*first };
    }
    let last = keyframes[keyframes.len() - 1];
    if time >= last.t {
        return ZoomKeyframe { t: time, ..last };
    }
    let (mut lo, mut hi) = (0usize, keyframes.len() - 1);
    while lo + 1 < hi {
        let mid = (lo + hi) >> 1;
        if keyframes[mid].t <= time {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let a = keyframes[lo];
    let b = keyframes[hi];
    let u = (time - a.t) / js_max(1e-9, b.t - a.t);
    ZoomKeyframe {
        t: time,
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        scale: a.scale + (b.scale - a.scale) * u,
    }
}

/// Zoom state derived from the active fragment for one frame
/// (`resolveZoomReactiveState`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZoomReactive {
    pub face_cam_presence_scale: f64,
    /// Full follow-cursor scale while easing, for the in-place zoom-in.
    pub target_scale: Option<f64>,
}

pub fn zoom_reactive_state(active: Option<&ZoomFragment>, time: f64) -> ZoomReactive {
    let Some(fragment) = active else {
        return ZoomReactive {
            face_cam_presence_scale: 1.0,
            target_scale: None,
        };
    };
    let face_cam_presence_scale = if shrinks_face_cam(fragment) {
        crate::layout::face_cam_zoom_presence_scale(
            zoom_envelope(fragment, time),
            face_cam_presence_min_scale(fragment),
        )
    } else {
        1.0
    };
    ZoomReactive {
        face_cam_presence_scale,
        target_scale: (fragment.mode == ZoomMode::FollowCursor)
            .then(|| js_max(1.0, fragment.target_scale)),
    }
}

/// The camera at one instant: what `getZoomPanAtTime` + `resolveZoomReactiveState`
/// hand the compositor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZoomSample {
    pub focus: Vec2,
    pub scale: f64,
    pub reactive: ZoomReactive,
}

/// Every fragment's keyframes, integrated up front.
pub struct ZoomTimeline {
    fragments: Vec<ZoomFragment>,
    keyframes: Vec<Vec<ZoomKeyframe>>,
}

impl ZoomTimeline {
    pub fn new(
        fragments: &[ZoomFragment],
        metadata: Option<&RecordingMetadata>,
        crop: Option<CropNorm>,
        recording: Rect,
    ) -> Self {
        let keyframes = fragments
            .iter()
            .map(|f| {
                compute_zoom_keyframes(f, metadata, ZOOM_MOTION_SAMPLE_FPS, crop, Some(recording))
            })
            .collect();
        Self {
            fragments: fragments.to_vec(),
            keyframes,
        }
    }

    pub fn sample(&self, time: f64) -> ZoomSample {
        match find_active_fragment(&self.fragments, time) {
            None => ZoomSample {
                focus: Vec2::CENTER,
                scale: 1.0,
                reactive: zoom_reactive_state(None, time),
            },
            Some((index, fragment)) => {
                let k = interpolate_zoom_keyframe(&self.keyframes[index], time);
                ZoomSample {
                    focus: Vec2::new(k.x, k.y),
                    scale: k.scale,
                    reactive: zoom_reactive_state(Some(fragment), time),
                }
            }
        }
    }
}

/// Scale about the stage origin, then translate (`CameraTransform`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraTransform {
    pub scale: f64,
    pub x: f64,
    pub y: f64,
}

impl CameraTransform {
    pub const IDENTITY: CameraTransform = CameraTransform {
        scale: 1.0,
        x: 0.0,
        y: 0.0,
    };

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (self.x + x * self.scale, self.y + y * self.scale)
    }
}

/// Centre `focus` (recording NDC) on the stage at `scale`; during a
/// follow-cursor zoom-in, translate by progress so the zoom happens in place
/// (`computeCameraTransform`).
pub fn camera_transform(
    stage_width: f64,
    stage_height: f64,
    video: Rect,
    focus: Vec2,
    scale: f64,
    target_scale: Option<f64>,
) -> CameraTransform {
    let scale = js_max(1.0, scale);
    if stage_width <= 0.0
        || stage_height <= 0.0
        || video.width <= 0.0
        || video.height <= 0.0
        || scale <= 1.0 + 1e-6
    {
        return CameraTransform::IDENTITY;
    }
    let focus_stage_x = video.x + focus.x * video.width;
    let focus_stage_y = video.y + focus.y * video.height;
    let target_scale = js_max(scale, target_scale.unwrap_or(scale));
    let progress = if target_scale <= 1.0 + 1e-6 {
        1.0
    } else {
        clamp((scale - 1.0) / (target_scale - 1.0), 0.0, 1.0)
    };
    CameraTransform {
        scale,
        x: progress * (stage_width / 2.0 - focus_stage_x * target_scale),
        y: progress * (stage_height / 2.0 - focus_stage_y * target_scale),
    }
}

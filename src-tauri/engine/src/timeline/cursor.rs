//! Cursor overlay timeline: where the glyph is, which glyph, and how visible.
//!
//! Ported from `engine/cursorOverlay.ts`, `engine/cursorMotion.ts` and the
//! compositor's `render/pixi/pixiCursor.ts`.
//!
//! One deliberate change: the editor advances its cursor spring once per
//! *rendered* frame, so the preview (display refresh) and the export (fixed
//! fps) integrate it at different rates and can disagree. Here the spring is
//! integrated once, up front, on the 60 fps frame grid of the kept segments —
//! with exactly the editor's snap and trail rules — and every frame samples
//! that timeline. A 60 fps export therefore reproduces the editor's stepping
//! exactly, and any other rate (or a preview) sees the same motion.

use crate::document::{
    CropNorm, CursorSettings, CursorShape, CursorStyle, PressInterval, RecordingMetadata,
    TrimSegment,
};
use crate::math::{clamp, js_max, js_min, smoothstep01};
use crate::timeline::segments::plan_frame_times;
use crate::timeline::zoom::Vec2;

/// Rate the cursor spring is integrated at (see module docs).
pub const CURSOR_MOTION_HZ: f64 = 60.0;

// --- Recorded track sampling -------------------------------------------------

/// Linear interpolation of the raw recorded track (`sampleCursorAtTime`).
pub fn sample_cursor_at_time(metadata: &RecordingMetadata, time: f64) -> Option<Vec2> {
    let samples = &metadata.cursor_samples;
    let first = samples.first()?;
    if time <= first.t {
        return Some(Vec2::new(first.x, first.y));
    }
    let last = samples[samples.len() - 1];
    if time >= last.t {
        return Some(Vec2::new(last.x, last.y));
    }
    let (mut lo, mut hi) = (0usize, samples.len() - 1);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if samples[mid].t <= time {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let a = samples[lo];
    let b = samples[(lo + 1).min(samples.len() - 1)];
    let span = js_max(1e-6, b.t - a.t);
    let p = js_min(1.0, js_max(0.0, (time - a.t) / span));
    Some(Vec2::new(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p))
}

/// Raw track mapped into crop space and clamped (`mapCursorToContentNdc`).
fn content_position(
    metadata: &RecordingMetadata,
    time: f64,
    crop: Option<CropNorm>,
) -> Option<Vec2> {
    let p = sample_cursor_at_time(metadata, time)?;
    Some(match crop {
        None => Vec2::new(clamp(p.x, 0.0, 1.0), clamp(p.y, 0.0, 1.0)),
        Some(c) => {
            let w = js_max(1e-9, c.width);
            let h = js_max(1e-9, c.height);
            Vec2::new(
                clamp((p.x - c.x) / w, 0.0, 1.0),
                clamp((p.y - c.y) / h, 0.0, 1.0),
            )
        }
    })
}

// --- Loop return ------------------------------------------------------------

/// Glide window that returns the cursor to its first-frame position at the end
/// of the final video (`CursorLoopReturn`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorLoopReturn {
    pub target_time: f64,
    pub window_start: f64,
    pub window_end: f64,
}

pub const CURSOR_LOOP_RETURN_S: f64 = 0.75;

/// `computeCursorLoopReturn`.
pub fn cursor_loop_return(
    segments: &[TrimSegment],
    fallback_duration: f64,
) -> Option<CursorLoopReturn> {
    let target_time = segments.first().map_or(0.0, |s| s.start);
    let end = segments.last().map_or(fallback_duration, |s| s.end);
    let last_start = segments.last().map_or(0.0, |s| s.start);
    if !end.is_finite() || end <= target_time {
        return None;
    }
    let window = js_min(CURSOR_LOOP_RETURN_S, end - last_start);
    if window <= 1e-3 || window.is_nan() {
        return None;
    }
    Some(CursorLoopReturn {
        target_time,
        window_start: end - window,
        window_end: end,
    })
}

fn loop_return_blend(loop_return: &CursorLoopReturn, t: f64) -> f64 {
    if t <= loop_return.window_start {
        return 0.0;
    }
    let span = js_max(1e-6, loop_return.window_end - loop_return.window_start);
    smoothstep01((js_min(t, loop_return.window_end) - loop_return.window_start) / span)
}

// --- Idle auto-hide ---------------------------------------------------------

const IDLE_DELAY_S: f64 = 1.5;
const IDLE_FADE_OUT_S: f64 = 0.5;
const IDLE_FADE_IN_S: f64 = 0.35;
const IDLE_MOVE_EPSILON: f64 = 0.004;
const IDLE_MIN_HIDDEN_S: f64 = 0.4;

#[derive(Debug, Clone, Copy, PartialEq)]
struct HideWindow {
    fade_out_start: f64,
    fade_in_end: f64,
}

/// Stillness windows where the cursor fades out (`computeCursorHideWindows`).
fn hide_windows(metadata: &RecordingMetadata) -> Vec<HideWindow> {
    let samples = &metadata.cursor_samples;
    let Some(first) = samples.first() else {
        return Vec::new();
    };
    let clicks = &metadata.cursor_click_samples;
    let mut windows = Vec::new();
    fn push_idle_gap(idle_start: f64, idle_end: f64, windows: &mut Vec<HideWindow>) {
        let min_idle_span = IDLE_DELAY_S + IDLE_FADE_OUT_S + IDLE_MIN_HIDDEN_S + IDLE_FADE_IN_S;
        if idle_end - idle_start >= min_idle_span {
            windows.push(HideWindow {
                fade_out_start: idle_start + IDLE_DELAY_S,
                fade_in_end: idle_end,
            });
        }
    }

    let (mut anchor_x, mut anchor_y) = (first.x, first.y);
    let mut last_activity = first.t;
    let mut click_idx = 0;
    for sample in samples {
        while click_idx < clicks.len() && clicks[click_idx].t <= sample.t {
            let click = clicks[click_idx];
            push_idle_gap(last_activity, click.t, &mut windows);
            last_activity = click.t;
            anchor_x = click.x;
            anchor_y = click.y;
            click_idx += 1;
        }
        let dx = sample.x - anchor_x;
        let dy = sample.y - anchor_y;
        if dx * dx + dy * dy > IDLE_MOVE_EPSILON * IDLE_MOVE_EPSILON {
            push_idle_gap(last_activity, sample.t, &mut windows);
            last_activity = sample.t;
            anchor_x = sample.x;
            anchor_y = sample.y;
        }
    }

    let track_end = samples[samples.len() - 1].t;
    if track_end - last_activity >= IDLE_DELAY_S + IDLE_FADE_OUT_S {
        windows.push(HideWindow {
            fade_out_start: last_activity + IDLE_DELAY_S,
            fade_in_end: f64::INFINITY,
        });
    }
    windows
}

fn idle_opacity(windows: &[HideWindow], time: f64) -> f64 {
    // Last window whose fade-out has begun.
    let count = windows.partition_point(|w| w.fade_out_start <= time);
    let Some(w) = count.checked_sub(1).map(|i| windows[i]) else {
        return 1.0;
    };
    if time >= w.fade_in_end {
        return 1.0;
    }
    let fade_out = 1.0 - smoothstep01((time - w.fade_out_start) / IDLE_FADE_OUT_S);
    let fade_in = smoothstep01(1.0 - (w.fade_in_end - time) / IDLE_FADE_IN_S);
    js_max(fade_out, fade_in)
}

// --- Shape crossfade ----------------------------------------------------------

const SHAPE_CROSSFADE_S: f64 = 0.14;

/// The recorded shape at `time` and the crossfade it is in
/// (`sampleCursorShapeTransition`). `progress` is 1 once settled.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShapeTransition {
    pub shape: CursorShape,
    pub prev_shape: CursorShape,
    pub progress: f64,
}

fn shape_transition(metadata: &RecordingMetadata, time: f64) -> ShapeTransition {
    let samples = &metadata.cursor_samples;
    let shape_of = |i: usize| samples[i].shape.unwrap_or_default();
    if samples.is_empty() || time <= samples[0].t {
        let first = samples.first().and_then(|s| s.shape).unwrap_or_default();
        return ShapeTransition {
            shape: first,
            prev_shape: first,
            progress: 1.0,
        };
    }
    let (mut lo, mut hi) = (0usize, samples.len() - 1);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if samples[mid].t <= time {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let shape = shape_of(lo);
    let window_start = time - SHAPE_CROSSFADE_S;
    let mut run_start = lo;
    while run_start > 0
        && samples[run_start - 1].t > window_start
        && shape_of(run_start - 1) == shape
    {
        run_start -= 1;
    }
    if run_start > 0 {
        let changed_at = samples[run_start].t;
        let prev_shape = shape_of(run_start - 1);
        if prev_shape != shape && changed_at > window_start {
            let track_end = samples[samples.len() - 1].t;
            let fade_span = js_min(SHAPE_CROSSFADE_S, track_end - changed_at);
            if fade_span > 1e-3 {
                return ShapeTransition {
                    shape,
                    prev_shape,
                    progress: clamp((time - changed_at) / fade_span, 0.0, 1.0),
                };
            }
        }
    }
    ShapeTransition {
        shape,
        prev_shape: shape,
        progress: 1.0,
    }
}

// --- Clicks ----------------------------------------------------------------

pub const CURSOR_CLICK_FREEZE_S: f64 = 0.1;
pub const CURSOR_SEEK_GAP_S: f64 = 0.12;
pub const CURSOR_BOUNCE_DURATION_S: f64 = 0.35;
pub const CURSOR_CLICK_FX_DURATION_S: f64 = 0.55;
pub const CURSOR_CLICK_FX_DELAY_S: f64 = CURSOR_BOUNCE_DURATION_S * 0.5;

/// Within the freeze window around a mouse-down (`nearCursorClick`).
pub fn near_cursor_click(press: &[PressInterval], time: f64) -> bool {
    press
        .iter()
        .any(|p| time >= p.start - CURSOR_CLICK_FREEZE_S && time <= p.start + CURSOR_CLICK_FREEZE_S)
}

/// Index of the last press starting at or before `time`.
fn last_press_at(press: &[PressInterval], time: f64) -> Option<&PressInterval> {
    let (mut lo, mut hi, mut idx): (isize, isize, isize) = (0, press.len() as isize - 1, -1);
    while lo <= hi {
        let mid = (lo + hi) >> 1;
        if press[mid as usize].start <= time {
            idx = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    (idx >= 0).then(|| &press[idx as usize])
}

/// Sin squash around a click; the tip stays put (`cursorBounceScale`).
pub fn cursor_bounce_scale(press: &[PressInterval], time: f64, intensity: f64) -> f64 {
    if intensity <= 0.001 || press.is_empty() {
        return 1.0;
    }
    let Some(p) = last_press_at(press, time) else {
        return 1.0;
    };
    let age = time - p.start;
    if !(0.0..=CURSOR_BOUNCE_DURATION_S).contains(&age) {
        return 1.0;
    }
    let progress = age / CURSOR_BOUNCE_DURATION_S;
    js_max(
        0.72,
        1.0 - (progress * std::f64::consts::PI).sin() * intensity,
    )
}

/// Click ring progress: 1 just started → 0 finished; 0 when idle
/// (`cursorClickFxProgress`).
pub fn cursor_click_fx_progress(press: &[PressInterval], time: f64) -> f64 {
    let Some(p) = last_press_at(press, time) else {
        return 0.0;
    };
    let age = time - p.start - CURSOR_CLICK_FX_DELAY_S;
    if !(0.0..=CURSOR_CLICK_FX_DURATION_S).contains(&age) {
        return 0.0;
    }
    1.0 - age / CURSOR_CLICK_FX_DURATION_S
}

/// Deterministic wobble added to the target when sway is on (`swayOffset`).
fn sway_offset(time: f64, sway: f64) -> Vec2 {
    if sway <= 0.0 {
        return Vec2::new(0.0, 0.0);
    }
    let amp = sway * 0.01;
    Vec2::new((time * 4.2).sin() * amp, (time * 3.1).cos() * amp)
}

// --- Spring ------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpringConfig {
    pub stiffness: f64,
    pub damping: f64,
    pub mass: f64,
    pub rest_delta: f64,
    pub rest_speed: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpringState {
    pub value: f64,
    pub velocity: f64,
    pub initialized: bool,
}

impl SpringState {
    pub fn new(value: f64) -> Self {
        Self {
            value,
            velocity: 0.0,
            initialized: false,
        }
    }

    fn reset(&mut self, value: f64) {
        self.value = value;
        self.velocity = 0.0;
        self.initialized = false;
    }
}

/// Cap a frame step so a hitch cannot explode the spring (`clampDeltaSec`).
pub fn clamp_delta_sec(dt: f64, fallback: f64) -> f64 {
    if !dt.is_finite() || dt <= 0.0 {
        return fallback;
    }
    js_min(0.08, js_max(1.0 / 240.0, dt))
}

fn spring_position(t: f64, target: f64, delta: f64, velocity: f64, zeta: f64, omega: f64) -> f64 {
    if zeta < 1.0 {
        let wd = omega * (1.0 - zeta * zeta).sqrt();
        let env = (-zeta * omega * t).exp();
        return target
            - env
                * (((velocity + zeta * omega * delta) / wd) * (wd * t).sin()
                    + delta * (wd * t).cos());
    }
    if zeta == 1.0 {
        return target - (-omega * t).exp() * (delta + (velocity + omega * delta) * t);
    }
    let wd = omega * (zeta * zeta - 1.0).sqrt();
    let env = (-zeta * omega * t).exp();
    let freq_t = js_min(wd * t, 300.0);
    target
        - (env * ((velocity + zeta * omega * delta) * freq_t.sinh() + wd * delta * freq_t.cosh()))
            / wd
}

/// One analytic spring step (`stepSpringValue`).
pub fn step_spring_value(
    state: &mut SpringState,
    target: f64,
    delta_sec: f64,
    config: &SpringConfig,
) -> f64 {
    let dt = clamp_delta_sec(delta_sec, 1.0 / 60.0);
    if !state.initialized || !state.value.is_finite() {
        state.value = target;
        state.velocity = 0.0;
        state.initialized = true;
        return state.value;
    }
    if (target - state.value).abs() <= config.rest_delta
        && state.velocity.abs() <= config.rest_speed
    {
        state.value = target;
        state.velocity = 0.0;
        return state.value;
    }
    let omega = (config.stiffness / config.mass).sqrt();
    let zeta = config.damping / (2.0 * (config.stiffness * config.mass).sqrt());
    let delta = target - state.value;
    let velocity = -state.velocity;
    let current = spring_position(dt, target, delta, velocity, zeta, omega);
    if zeta >= 1.0 {
        let crossed = (state.value <= target && current > target)
            || (state.value >= target && current < target);
        if crossed {
            state.value = target;
            state.velocity = 0.0;
            return state.value;
        }
    }
    let eps = 1e-4;
    let ahead = spring_position(dt + eps, target, delta, velocity, zeta, omega);
    let vel = (ahead - current) / eps;
    if vel.abs() <= config.rest_speed && (target - current).abs() <= config.rest_delta {
        state.value = target;
        state.velocity = 0.0;
    } else {
        state.value = current;
        state.velocity = vel;
    }
    state.value
}

/// Smoothness slider → spring (`getCursorSpringConfig`).
pub fn cursor_spring_config(smoothness: f64) -> SpringConfig {
    let s = clamp(smoothness, 0.0, 1.0);
    if s <= 0.02 {
        return SpringConfig {
            stiffness: 1200.0,
            damping: 120.0,
            mass: 1.0,
            rest_delta: 0.0001,
            rest_speed: 0.001,
        };
    }
    SpringConfig {
        stiffness: 760.0 - s * 480.0,
        damping: 36.0 + s * 28.0,
        mass: 0.85 + s * 0.65,
        rest_delta: 0.0002,
        rest_speed: 0.01,
    }
}

const SWAY_MAX_ROT: f64 = std::f64::consts::PI / 18.0;
const SWAY_SPEED_REF: f64 = 1.4;
const SWAY_VERTICAL_WEIGHT: f64 = 0.65;
const SWAY_INTENSITY: f64 = 3.0;

/// Velocity lean (`cursorSwayRotation`).
pub fn cursor_sway_rotation(dx: f64, dy: f64, delta_sec: f64, sway: f64) -> f64 {
    if sway <= 0.0 {
        return 0.0;
    }
    let dist = dx.hypot(dy);
    if !dist.is_finite() || dist < 1e-6 {
        return 0.0;
    }
    let speed = dist / clamp_delta_sec(delta_sec, 1.0 / 60.0);
    let speed_factor = clamp(speed / SWAY_SPEED_REF, 0.0, 1.0);
    if speed_factor <= 0.0 {
        return 0.0;
    }
    let bias = clamp((dx + dy * SWAY_VERTICAL_WEIGHT) / dist, -1.0, 1.0);
    bias * speed_factor * SWAY_MAX_ROT * sway * SWAY_INTENSITY
}

/// Ghosts in the motion trail (`cursorTrailLength`).
pub fn cursor_trail_length(motion_blur: f64) -> usize {
    if motion_blur <= 0.05 || motion_blur.is_nan() {
        return 0;
    }
    js_max(1.0, crate::math::js_round(motion_blur * 5.0)) as usize
}

/// Options for one [`CursorMotionState::update`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MotionOptions {
    pub smoothness: f64,
    pub sway: f64,
    pub motion_blur: f64,
    pub freeze: bool,
    pub near_click: bool,
}

/// Result of one update.
#[derive(Debug, Clone, PartialEq)]
pub struct MotionOutput {
    pub position: Vec2,
    pub rotation: f64,
    pub trail: Vec<Vec2>,
}

/// The editor's stateful cursor chase (`CursorMotionState`), kept verbatim:
/// [`CursorTimeline`] drives it on a fixed grid.
#[derive(Debug, Clone)]
pub struct CursorMotionState {
    x: f64,
    y: f64,
    trail: Vec<Vec2>,
    x_spring: SpringState,
    y_spring: SpringState,
    rot_spring: SpringState,
    last_time: Option<f64>,
    initialized: bool,
}

impl Default for CursorMotionState {
    fn default() -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            trail: Vec::new(),
            x_spring: SpringState::new(0.5),
            y_spring: SpringState::new(0.5),
            rot_spring: SpringState::new(0.0),
            last_time: None,
            initialized: false,
        }
    }
}

impl CursorMotionState {
    fn snap_to(&mut self, x: f64, y: f64, time: f64) {
        self.x = x;
        self.y = y;
        self.x_spring = SpringState {
            value: x,
            velocity: 0.0,
            initialized: true,
        };
        self.y_spring = SpringState {
            value: y,
            velocity: 0.0,
            initialized: true,
        };
        self.rot_spring.reset(0.0);
        self.rot_spring.initialized = true;
        self.trail.clear();
        self.last_time = Some(time);
        self.initialized = true;
    }

    fn push_trail(&mut self, x: f64, y: f64, max_len: usize) {
        if max_len == 0 {
            self.trail.clear();
            return;
        }
        self.trail.insert(0, Vec2::new(x, y));
        self.trail.truncate(max_len);
    }

    pub fn update(&mut self, target: Vec2, time: f64, opts: MotionOptions) -> MotionOutput {
        if !self.initialized {
            self.snap_to(target.x, target.y, time);
            return MotionOutput {
                position: Vec2::new(self.x, self.y),
                rotation: 0.0,
                trail: Vec::new(),
            };
        }
        let last = self.last_time;
        let dt = last.map_or(1.0 / 60.0, |l| clamp_delta_sec(time - l, 1.0 / 60.0));
        let seeked = last.is_some_and(|l| time < l - 1e-4 || time - l > CURSOR_SEEK_GAP_S);

        if opts.freeze || opts.near_click || seeked || opts.smoothness <= 0.02 {
            let (prev_x, prev_y) = (self.x, self.y);
            self.snap_to(target.x, target.y, time);
            if !opts.near_click && !seeked && opts.motion_blur > 0.05 {
                self.push_trail(prev_x, prev_y, cursor_trail_length(opts.motion_blur));
            }
            return MotionOutput {
                position: Vec2::new(self.x, self.y),
                rotation: 0.0,
                trail: self.trail.clone(),
            };
        }

        self.push_trail(self.x, self.y, cursor_trail_length(opts.motion_blur));
        let config = cursor_spring_config(opts.smoothness);
        let (prev_x, prev_y) = (self.x, self.y);
        self.x = step_spring_value(&mut self.x_spring, target.x, dt, &config);
        self.y = step_spring_value(&mut self.y_spring, target.y, dt, &config);
        self.last_time = Some(time);

        let sway_target = cursor_sway_rotation(self.x - prev_x, self.y - prev_y, dt, opts.sway);
        let rotation = step_spring_value(
            &mut self.rot_spring,
            sway_target,
            dt,
            &cursor_spring_config(js_min(1.0, opts.smoothness + 0.15)),
        );
        MotionOutput {
            position: Vec2::new(self.x, self.y),
            rotation,
            trail: self.trail.clone(),
        }
    }
}

// --- The per-export cursor timeline ------------------------------------------

/// One integrated grid step.
#[derive(Debug, Clone, Copy, PartialEq)]
struct MotionStep {
    time: f64,
    position: Vec2,
    rotation: f64,
    /// Valid trail entries after this step (the positions of the steps before).
    trail_len: usize,
    /// Index of the first step of the run this step belongs to (no gap/snap
    /// back-references cross a run start).
    visible: bool,
}

/// What the overlay draws at one instant.
#[derive(Debug, Clone, PartialEq)]
pub struct CursorFrame {
    /// Spring-smoothed tip, normalized inside the recording rect.
    pub tip: Vec2,
    pub rotation: f64,
    /// Squash scale around a click.
    pub bounce: f64,
    /// Glyph height before bounce, in composition px (`baseH`).
    pub height: f64,
    /// Head glyphs at the tip: one, or two while crossfading shapes.
    pub heads: Vec<(CursorShape, f64)>,
    /// Shape of the trail ghosts (the head's current shape).
    pub trail_shape: CursorShape,
    /// Ghost tips (most recent first) with their alpha.
    pub trail: Vec<(Vec2, f64)>,
    /// Click-ring progress (0 = none).
    pub fx_progress: f64,
}

/// Cursor state as a pure function of source time, for one export.
pub struct CursorTimeline {
    settings: CursorSettings,
    metadata: RecordingMetadata,
    crop: Option<CropNorm>,
    loop_return: Option<CursorLoopReturn>,
    loop_target: Option<Vec2>,
    hide_windows: Vec<HideWindow>,
    steps: Vec<MotionStep>,
}

impl CursorTimeline {
    pub fn new(
        settings: CursorSettings,
        metadata: Option<&RecordingMetadata>,
        crop: Option<CropNorm>,
        segments: &[TrimSegment],
        duration: f64,
    ) -> Option<Self> {
        let metadata = metadata?.clone();
        if !settings.show_cursor || metadata.cursor_samples.is_empty() {
            return None;
        }
        let loop_return = if settings.loop_cursor {
            cursor_loop_return(segments, duration)
        } else {
            None
        };
        let loop_target =
            loop_return.and_then(|l| content_position(&metadata, l.target_time, crop));
        let hide_windows = if settings.hide_static_cursor {
            hide_windows(&metadata)
        } else {
            Vec::new()
        };
        let mut timeline = Self {
            settings,
            metadata,
            crop,
            loop_return,
            loop_target,
            hide_windows,
            steps: Vec::new(),
        };
        timeline.integrate(segments);
        Some(timeline)
    }

    /// Recorded position with the loop-return glide (`resolvePos`).
    fn resolve_position(&self, t: f64) -> Option<Vec2> {
        let p = content_position(&self.metadata, t, self.crop)?;
        let (Some(loop_return), Some(target)) = (self.loop_return, self.loop_target) else {
            return Some(p);
        };
        let blend = loop_return_blend(&loop_return, t);
        if blend <= 0.0 {
            return Some(p);
        }
        Some(Vec2::new(
            p.x + (target.x - p.x) * blend,
            p.y + (target.y - p.y) * blend,
        ))
    }

    fn opacity(&self, t: f64) -> f64 {
        if !self.settings.hide_static_cursor {
            return 1.0;
        }
        let mut opacity = idle_opacity(&self.hide_windows, t);
        if let Some(loop_return) = self.loop_return {
            let blend = loop_return_blend(&loop_return, t);
            if blend > 0.0 {
                let target = idle_opacity(&self.hide_windows, loop_return.target_time);
                opacity += (target - opacity) * blend;
            }
        }
        opacity
    }

    /// The tip the spring chases: recorded position plus sway wobble.
    fn head_target(&self, t: f64) -> Option<Vec2> {
        let base = self.resolve_position(t)?;
        let sway = sway_offset(t, self.settings.sway);
        Some(Vec2::new(
            clamp(base.x + sway.x, 0.0, 1.0),
            clamp(base.y + sway.y, 0.0, 1.0),
        ))
    }

    fn visible_at(&self, t: f64) -> bool {
        self.opacity(t) > 0.001 && self.resolve_position(t).is_some()
    }

    /// Run the editor's chase over the 60 fps frame grid of the kept segments.
    /// Hidden frames don't advance the spring — like the compositor, which
    /// skips the overlay entirely while the cursor is faded out.
    fn integrate(&mut self, segments: &[TrimSegment]) {
        let grid = plan_frame_times(segments, CURSOR_MOTION_HZ);
        let mut motion = CursorMotionState::default();
        let press = self.metadata.cursor_press_intervals.clone();
        let mut steps = Vec::with_capacity(grid.len());
        for &t in &grid {
            let visible = self.visible_at(t);
            let target = if visible { self.head_target(t) } else { None };
            let Some(target) = target else {
                let prev = steps.last().copied();
                steps.push(MotionStep {
                    time: t,
                    position: prev.map_or(Vec2::CENTER, |s: MotionStep| s.position),
                    rotation: 0.0,
                    trail_len: 0,
                    visible: false,
                });
                continue;
            };
            let out = motion.update(
                target,
                t,
                MotionOptions {
                    smoothness: self.settings.smoothness,
                    sway: self.settings.sway,
                    motion_blur: self.settings.motion_blur,
                    freeze: false,
                    near_click: near_cursor_click(&press, t),
                },
            );
            steps.push(MotionStep {
                time: t,
                position: out.position,
                rotation: out.rotation,
                trail_len: out.trail.len(),
                visible: true,
            });
        }
        self.steps = steps;
    }

    /// Neighbouring grid steps and the blend between them at `t`.
    fn locate(&self, t: f64) -> Option<(usize, usize, f64)> {
        if self.steps.is_empty() {
            return None;
        }
        let after = self.steps.partition_point(|s| s.time < t);
        if after == 0 {
            return Some((0, 0, 0.0));
        }
        if after >= self.steps.len() {
            let last = self.steps.len() - 1;
            return Some((last, last, 0.0));
        }
        let (a, b) = (after - 1, after);
        let gap = self.steps[b].time - self.steps[a].time;
        // Never blend across a trim gap or a hidden/visible boundary.
        if gap > 1.5 / CURSOR_MOTION_HZ || !self.steps[a].visible || !self.steps[b].visible {
            let nearer = if t - self.steps[a].time <= self.steps[b].time - t {
                a
            } else {
                b
            };
            return Some((nearer, nearer, 0.0));
        }
        Some((a, b, (t - self.steps[a].time) / gap))
    }

    fn motion_at(&self, t: f64) -> Option<(Vec2, f64, usize)> {
        let (a, b, u) = self.locate(t)?;
        let (sa, sb) = (self.steps[a], self.steps[b]);
        if !sa.visible || !sb.visible {
            return None;
        }
        let lerp = |p: f64, q: f64| p + (q - p) * u;
        let nearest = if u < 0.5 { sa } else { sb };
        Some((
            Vec2::new(
                lerp(sa.position.x, sb.position.x),
                lerp(sa.position.y, sb.position.y),
            ),
            lerp(sa.rotation, sb.rotation),
            nearest.trail_len,
        ))
    }

    /// Everything the overlay needs to draw at source time `t`, for a
    /// recording rect `rect_width`×`rect_height` composition px.
    pub fn frame(&self, t: f64, rect_width: f64, rect_height: f64) -> Option<CursorFrame> {
        let opacity = self.opacity(t);
        if opacity <= 0.001 {
            return None;
        }
        self.resolve_position(t)?;
        let (tip, rotation, trail_len) = self.motion_at(t)?;

        let transition = shape_transition(&self.metadata, t);
        let fade_in = smoothstep01(transition.progress);
        let head_alpha = 0.95 * opacity;
        let heads = if fade_in < 1.0 && transition.prev_shape != transition.shape {
            vec![
                (transition.prev_shape, head_alpha * (1.0 - fade_in)),
                (transition.shape, head_alpha * fade_in),
            ]
        } else {
            vec![(transition.shape, head_alpha)]
        };
        // The compositor's trail alpha keys off the *last* head stamp.
        let last_head_alpha = heads[heads.len() - 1].1;

        let viewport_scale = js_max(0.55, js_min(rect_width, rect_height) / 1080.0);
        let height = 28.0 * viewport_scale * self.settings.size;

        let press = &self.metadata.cursor_press_intervals;
        let bounce = cursor_bounce_scale(press, t, self.settings.click_shrink);

        let mut trail = Vec::with_capacity(trail_len);
        for i in 0..trail_len {
            let ghost_t = t - (i as f64 + 1.0) / CURSOR_MOTION_HZ;
            let Some((pos, _, _)) = self.motion_at(ghost_t) else {
                break;
            };
            let age = (i as f64 + 1.0) / (trail_len as f64 + 1.0);
            let alpha = last_head_alpha
                * 0.22
                * (1.0 - age)
                * js_min(1.0, self.settings.motion_blur + 0.15);
            trail.push((pos, alpha));
        }

        Some(CursorFrame {
            tip,
            rotation,
            bounce,
            height,
            heads,
            trail_shape: transition.shape,
            trail,
            fx_progress: cursor_click_fx_progress(press, t),
        })
    }
}

/// Which SVG a style replays for a recorded shape, and its hotspot as a
/// fraction of the SVG viewBox (`shapeAssetSpec` + `THEME_HOTSPOTS`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorAssetSpec {
    /// Path under `public/cursors/`.
    pub file: &'static str,
    pub hotspot: (f64, f64),
    pub invert: bool,
}

pub fn cursor_asset_spec(style: CursorStyle, shape: CursorShape) -> CursorAssetSpec {
    use CursorShape as S;
    if style == CursorStyle::Figma && shape == S::Default {
        return CursorAssetSpec {
            file: "minimal.svg",
            hotspot: (0.1, 0.05),
            invert: false,
        };
    }
    let (macos, invert) = match style {
        CursorStyle::Macos => (true, false),
        CursorStyle::Tahoe | CursorStyle::Figma => (false, false),
        CursorStyle::TahoeInverted => (false, true),
    };
    let name = match shape {
        S::Default => "arrow",
        S::Pointer => "pointer",
        S::Text => "text",
        S::Grab => "open-hand",
        S::Grabbing => "closed-hand",
        S::Crosshair => "crosshair",
        S::ResizeEw => "resize-ew",
        S::ResizeNs => "resize-ns",
        S::ResizeNesw => "resize-nesw",
        S::ResizeNwse => "resize-nwse",
        S::NotAllowed => "not-allowed",
        S::Alias => "alias",
        S::Copy => "copy",
        S::ContextMenu => "context-menu",
    };
    let hotspot = if macos {
        match shape {
            S::Default => (0.34, 0.24),
            S::Pointer => (0.39, 0.26),
            S::NotAllowed | S::Copy => (0.23, 0.0),
            S::Alias => (0.63, 0.29),
            S::ContextMenu => (0.26, 0.21),
            _ => (0.5, 0.5),
        }
    } else {
        match shape {
            S::Default => (0.14, 0.06),
            S::Pointer => (0.4, 0.1),
            S::Text => (0.5, 0.44),
            S::Grab => (0.55, 0.57),
            S::Grabbing => (0.5, 0.46),
            S::Crosshair | S::ResizeEw => (0.5, 0.5),
            S::ResizeNs => (0.5, 0.49),
            S::ResizeNesw => (0.5, 0.46),
            S::ResizeNwse => (0.51, 0.46),
            S::NotAllowed | S::Copy => (0.23, 0.0),
            S::Alias => (0.63, 0.29),
            S::ContextMenu => (0.12, 0.05),
        }
    };
    let file = match (macos, name) {
        (true, "arrow") => "macos/arrow.svg",
        (true, "pointer") => "macos/pointer.svg",
        (true, "text") => "macos/text.svg",
        (true, "open-hand") => "macos/open-hand.svg",
        (true, "closed-hand") => "macos/closed-hand.svg",
        (true, "crosshair") => "macos/crosshair.svg",
        (true, "resize-ew") => "macos/resize-ew.svg",
        (true, "resize-ns") => "macos/resize-ns.svg",
        (true, "resize-nesw") => "macos/resize-nesw.svg",
        (true, "resize-nwse") => "macos/resize-nwse.svg",
        (true, "not-allowed") => "macos/not-allowed.svg",
        (true, "alias") => "macos/alias.svg",
        (true, "copy") => "macos/copy.svg",
        (true, _) => "macos/context-menu.svg",
        (false, "arrow") => "tahoe/arrow.svg",
        (false, "pointer") => "tahoe/pointer.svg",
        (false, "text") => "tahoe/text.svg",
        (false, "open-hand") => "tahoe/open-hand.svg",
        (false, "closed-hand") => "tahoe/closed-hand.svg",
        (false, "crosshair") => "tahoe/crosshair.svg",
        (false, "resize-ew") => "tahoe/resize-ew.svg",
        (false, "resize-ns") => "tahoe/resize-ns.svg",
        (false, "resize-nesw") => "tahoe/resize-nesw.svg",
        (false, "resize-nwse") => "tahoe/resize-nwse.svg",
        (false, "not-allowed") => "tahoe/not-allowed.svg",
        (false, "alias") => "tahoe/alias.svg",
        (false, "copy") => "tahoe/copy.svg",
        (false, _) => "tahoe/context-menu.svg",
    };
    CursorAssetSpec {
        file,
        hotspot,
        invert,
    }
}

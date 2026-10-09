//! Numeric helpers that reproduce JavaScript semantics exactly.
//!
//! The editor's math is TypeScript; the engine must land on the same numbers
//! (see `tests/golden.rs`). Where Rust and JS disagree — rounding of halves,
//! `Math.max` with NaN — these helpers spell out the JS behaviour.

/// A rectangle in some 2D pixel space.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// `Math.round`: halves round toward +∞ (`-2.5 → -2`), unlike `f64::round`.
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Math.min(max, Math.max(min, value))` — the clamp the editor uses
/// everywhere. With JS semantics a NaN `value` stays NaN.
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    js_min(max, js_max(min, value))
}

/// `Math.max(a, b)`: NaN if either side is NaN.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)`: NaN if either side is NaN.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `smoothstep` on `[0, 1]` after clamping.
pub fn smoothstep01(x: f64) -> f64 {
    let t = clamp(x, 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_matches_math_round() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(js_round(-0.4), -0.0);
        assert_eq!(js_round(1919.5), 1920.0);
    }

    #[test]
    fn clamp_keeps_nan_like_js() {
        assert!(clamp(f64::NAN, 0.0, 1.0).is_nan());
        assert_eq!(clamp(2.0, 0.0, 1.0), 1.0);
        assert_eq!(clamp(-2.0, 0.0, 1.0), 0.0);
    }
}

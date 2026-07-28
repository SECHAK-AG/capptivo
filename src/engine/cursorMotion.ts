/**
 * Analytic damped spring for cursor chase, plus click-freeze and velocity sway.
 *
 * Playback/export advance this state frame-by-frame. Seek / scrub / click
 * windows snap so the tip still lands on the recorded pixel.
 */

export type SpringState = {
  value: number;
  velocity: number;
  initialized: boolean;
};

export type SpringConfig = {
  stiffness: number;
  damping: number;
  mass: number;
  restDelta?: number;
  restSpeed?: number;
};

export function createSpringState(initialValue = 0): SpringState {
  return { value: initialValue, velocity: 0, initialized: false };
}

export function resetSpringState(state: SpringState, initialValue?: number): void {
  if (typeof initialValue === "number") state.value = initialValue;
  state.velocity = 0;
  state.initialized = false;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Cap frame dt so a hitch cannot explode the spring. */
export function clampDeltaSec(dt: number, fallback = 1 / 60): number {
  if (!Number.isFinite(dt) || dt <= 0) return fallback;
  return Math.min(0.08, Math.max(1 / 240, dt));
}

function springPosition(
  t: number,
  target: number,
  initialDelta: number,
  initialVelocity: number,
  zeta: number,
  omega: number,
): number {
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const env = Math.exp(-zeta * omega * t);
    return (
      target -
      env *
        (((initialVelocity + zeta * omega * initialDelta) / wd) * Math.sin(wd * t) +
          initialDelta * Math.cos(wd * t))
    );
  }
  if (zeta === 1) {
    return (
      target -
      Math.exp(-omega * t) *
        (initialDelta + (initialVelocity + omega * initialDelta) * t)
    );
  }
  const wd = omega * Math.sqrt(zeta * zeta - 1);
  const env = Math.exp(-zeta * omega * t);
  const freqT = Math.min(wd * t, 300);
  return (
    target -
    (env *
      ((initialVelocity + zeta * omega * initialDelta) * Math.sinh(freqT) +
        wd * initialDelta * Math.cosh(freqT))) /
      wd
  );
}

export function stepSpringValue(
  state: SpringState,
  target: number,
  deltaSec: number,
  config: SpringConfig,
): number {
  const dt = clampDeltaSec(deltaSec);
  if (!state.initialized || !Number.isFinite(state.value)) {
    state.value = target;
    state.velocity = 0;
    state.initialized = true;
    return state.value;
  }

  const restDelta = config.restDelta ?? 0.0005;
  const restSpeed = config.restSpeed ?? 0.02;
  if (
    Math.abs(target - state.value) <= restDelta &&
    Math.abs(state.velocity) <= restSpeed
  ) {
    state.value = target;
    state.velocity = 0;
    return state.value;
  }

  const { stiffness, damping, mass } = config;
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const initialDelta = target - state.value;
  const initialVelocity = -state.velocity;

  const current = springPosition(
    dt,
    target,
    initialDelta,
    initialVelocity,
    zeta,
    omega,
  );

  if (zeta >= 1) {
    const crossed =
      (state.value <= target && current > target) ||
      (state.value >= target && current < target);
    if (crossed) {
      state.value = target;
      state.velocity = 0;
      return state.value;
    }
  }

  const eps = 1e-4;
  const ahead = springPosition(
    dt + eps,
    target,
    initialDelta,
    initialVelocity,
    zeta,
    omega,
  );
  const vel = (ahead - current) / eps;
  if (Math.abs(vel) <= restSpeed && Math.abs(target - current) <= restDelta) {
    state.value = target;
    state.velocity = 0;
  } else {
    state.value = current;
    state.velocity = vel;
  }
  return state.value;
}

/**
 * Map Capptivo's 0–1 smoothness slider to a spring. Low = snappy chase;
 * high = soft glide. `0` is a near-instant snap.
 */
export function getCursorSpringConfig(smoothness: number): SpringConfig {
  const s = clamp(smoothness, 0, 1);
  if (s <= 0.02) {
    return {
      stiffness: 1200,
      damping: 120,
      mass: 1,
      restDelta: 0.0001,
      restSpeed: 0.001,
    };
  }
  return {
    stiffness: 760 - s * 480,
    damping: 36 + s * 28,
    mass: 0.85 + s * 0.65,
    restDelta: 0.0002,
    restSpeed: 0.01,
  };
}

/** Snap to raw tip this long around a click so zoomed presses stay on-target. */
export const CURSOR_CLICK_FREEZE_S = 0.1;
/** Seek/scrub discontinuity → snap instead of springing across the jump. */
export const CURSOR_SEEK_GAP_S = 0.12;

export function nearCursorClick(
  pressIntervals: readonly { start: number; end: number }[] | undefined,
  time: number,
  windowSec = CURSOR_CLICK_FREEZE_S,
): boolean {
  if (!pressIntervals || pressIntervals.length === 0) return false;
  for (const p of pressIntervals) {
    if (time >= p.start - windowSec && time <= p.start + windowSec) return true;
  }
  return false;
}

/** Sin bounce around a click; tip stays put (scale about anchor). */
export const CURSOR_BOUNCE_DURATION_S = 0.35;

export function cursorBounceScale(
  pressIntervals: readonly { start: number; end: number }[] | undefined,
  time: number,
  intensity: number,
): number {
  if (intensity <= 0.001 || !pressIntervals || pressIntervals.length === 0) {
    return 1;
  }
  let lo = 0;
  let hi = pressIntervals.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pressIntervals[mid].start <= time) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return 1;
  const age = time - pressIntervals[idx].start;
  if (age < 0 || age > CURSOR_BOUNCE_DURATION_S) return 1;
  const progress = age / CURSOR_BOUNCE_DURATION_S;
  // intensity 0–0.4 → peak shrink; floor keeps the glyph readable.
  return Math.max(0.72, 1 - Math.sin(progress * Math.PI) * intensity);
}

export const CURSOR_CLICK_EFFECT_IDS = [
  "none",
  "ripple",
  "spotlight",
  "echo",
] as const;
export type CursorClickEffectId = (typeof CURSOR_CLICK_EFFECT_IDS)[number];

export const CURSOR_CLICK_FX_DURATION_S = 0.55;
/** FX starts halfway through the bounce so the press reads first. */
export const CURSOR_CLICK_FX_DELAY_S = CURSOR_BOUNCE_DURATION_S * 0.5;

/** 1 → just started, 0 → finished; 0 when inactive. */
export function cursorClickFxProgress(
  pressIntervals: readonly { start: number; end: number }[] | undefined,
  time: number,
): number {
  if (!pressIntervals || pressIntervals.length === 0) return 0;
  let lo = 0;
  let hi = pressIntervals.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pressIntervals[mid].start <= time) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return 0;
  const age = time - pressIntervals[idx].start - CURSOR_CLICK_FX_DELAY_S;
  if (age < 0 || age > CURSOR_CLICK_FX_DURATION_S) return 0;
  return 1 - age / CURSOR_CLICK_FX_DURATION_S;
}

const SWAY_MAX_ROT = Math.PI / 18;
const SWAY_SPEED_REF = 1.4; // NDC units / sec — brisk full-screen flick
const SWAY_VERTICAL_WEIGHT = 0.65;
const SWAY_INTENSITY = 3;

/** Velocity-based lean; 0 when still. Rotation only — hotspot stays put. */
export function cursorSwayRotation(
  dxNdc: number,
  dyNdc: number,
  deltaSec: number,
  sway: number,
): number {
  if (sway <= 0) return 0;
  const dist = Math.hypot(dxNdc, dyNdc);
  if (!Number.isFinite(dist) || dist < 1e-6) return 0;
  const speed = dist / clampDeltaSec(deltaSec);
  const speedFactor = clamp(speed / SWAY_SPEED_REF, 0, 1);
  if (speedFactor <= 0) return 0;
  const bias = clamp((dxNdc + dyNdc * SWAY_VERTICAL_WEIGHT) / dist, -1, 1);
  return bias * speedFactor * SWAY_MAX_ROT * sway * SWAY_INTENSITY;
}

/** Max trail ghosts from the spring path (not raw samples). */
export function cursorTrailLength(motionBlur: number): number {
  if (motionBlur <= 0.05) return 0;
  return Math.max(1, Math.round(motionBlur * 5));
}

/**
 * Stateful NDC chase used by preview + export. Seek / click windows snap;
 * otherwise a spring glides toward the recorded tip. Trail is the recent
 * spring path (short), so ghosts stay coherent with the head.
 */
export class CursorMotionState {
  x = 0.5;
  y = 0.5;
  trail: Array<{ x: number; y: number }> = [];
  private xSpring = createSpringState(0.5);
  private ySpring = createSpringState(0.5);
  private rotSpring = createSpringState(0);
  private lastTimeSec: number | null = null;
  private initialized = false;

  snapTo(x: number, y: number, timeSec: number): void {
    this.x = x;
    this.y = y;
    this.xSpring.value = x;
    this.ySpring.value = y;
    this.xSpring.velocity = 0;
    this.ySpring.velocity = 0;
    this.xSpring.initialized = true;
    this.ySpring.initialized = true;
    resetSpringState(this.rotSpring, 0);
    this.rotSpring.initialized = true;
    this.trail = [];
    this.lastTimeSec = timeSec;
    this.initialized = true;
  }

  /**
   * Chase `target` in NDC. Returns rendered position, sway rotation, and trail.
   * `freeze` snaps (seek / pause scrub); click proximity also snaps.
   */
  update(
    target: { x: number; y: number },
    timeSec: number,
    opts: {
      smoothness: number;
      sway: number;
      motionBlur: number;
      freeze: boolean;
      nearClick: boolean;
    },
  ): { x: number; y: number; rotation: number; trail: Array<{ x: number; y: number }> } {
    if (!this.initialized) {
      this.snapTo(target.x, target.y, timeSec);
      return { x: this.x, y: this.y, rotation: 0, trail: [] };
    }

    const last = this.lastTimeSec;
    const dt =
      last == null ? 1 / 60 : clampDeltaSec(timeSec - last, 1 / 60);
    const seeked =
      last != null && (timeSec < last - 1e-4 || timeSec - last > CURSOR_SEEK_GAP_S);

    if (opts.freeze || opts.nearClick || seeked || opts.smoothness <= 0.02) {
      const prevX = this.x;
      const prevY = this.y;
      this.snapTo(target.x, target.y, timeSec);
      if (!opts.nearClick && !seeked && opts.motionBlur > 0.05) {
        this.pushTrail(prevX, prevY, cursorTrailLength(opts.motionBlur));
      }
      return { x: this.x, y: this.y, rotation: 0, trail: this.trail.slice() };
    }

    this.pushTrail(this.x, this.y, cursorTrailLength(opts.motionBlur));

    const config = getCursorSpringConfig(opts.smoothness);
    const prevX = this.x;
    const prevY = this.y;
    this.x = stepSpringValue(this.xSpring, target.x, dt, config);
    this.y = stepSpringValue(this.ySpring, target.y, dt, config);
    this.lastTimeSec = timeSec;

    const swayTarget = cursorSwayRotation(
      this.x - prevX,
      this.y - prevY,
      dt,
      opts.sway,
    );
    const rotation = stepSpringValue(
      this.rotSpring,
      swayTarget,
      dt,
      getCursorSpringConfig(Math.min(1, opts.smoothness + 0.15)),
    );

    return { x: this.x, y: this.y, rotation, trail: this.trail.slice() };
  }

  private pushTrail(x: number, y: number, maxLen: number): void {
    if (maxLen <= 0) {
      this.trail = [];
      return;
    }
    this.trail.unshift({ x, y });
    if (this.trail.length > maxLen) this.trail.length = maxLen;
  }
}

/**
 * Follow-cursor camera for zoom fragments.
 *
 * Logical focus uses a safe-zone recenter (only moves when the cursor leaves
 * an inner region of the zoomed view). A spring softens the rendered pan
 * toward that focus — never the reverse: safe-zone is evaluated against the
 * committed focus, not the lagging spring position.
 */
import type {
  RecordingMetadata,
  ZoomFragment,
  ZoomMotionState,
} from "./zoomMotion";

export type MappedPoint = { t: number; x: number; y: number };

export type SmartFollowConfig = {
  /** Inner fraction of the visible half-extent that stays locked (0.2–0.95). */
  safeZoneInnerFraction: number;
  /** After a click, bias the pan target toward the click for this long. */
  clickHoldSec: number;
};

export const SMART_FOLLOW_CONFIG: SmartFollowConfig = {
  // ~half of the visible half-span — matches a 0.25 edge-inset style deadzone.
  safeZoneInnerFraction: 0.5,
  clickHoldSec: 0.4,
};

export type SmartFollowPlanner = {
  config: SmartFollowConfig;
  samples: MappedPoint[];
  clicks: MappedPoint[];
};

export type SmartFollowRuntime = {
  /** Logical camera focus — safe-zone is relative to this, not spring pan. */
  committedTarget: { x: number; y: number };
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampTargetForScale(
  target: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  const safeScale = Math.max(1, scale);
  const halfVisible = 0.5 / safeScale;
  const minCenter = halfVisible;
  const maxCenter = 1 - halfVisible;
  if (minCenter >= maxCenter - 1e-9) {
    return { x: 0.5, y: 0.5 };
  }

  return {
    x: clamp(target.x, minCenter, maxCenter),
    y: clamp(target.y, minCenter, maxCenter),
  };
}

export function sampleMappedPointsAtTime(
  samples: MappedPoint[],
  time: number,
): { x: number; y: number } | null {
  if (samples.length === 0) {
    return null;
  }

  const first = samples[0];
  const last = samples[samples.length - 1];

  if (time <= first.t) {
    return { x: first.x, y: first.y };
  }

  if (time >= last.t) {
    return { x: last.x, y: last.y };
  }

  let lo = 0;
  let hi = samples.length - 1;

  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= time) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const a = samples[lo];
  const b = samples[hi];
  const span = Math.max(1e-9, b.t - a.t);
  const p = (time - a.t) / span;

  return {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
  };
}

export function isCursorInSafeZone(
  cursor: { x: number; y: number },
  center: { x: number; y: number },
  scale: number,
  innerFraction: number,
): boolean {
  const safeScale = Math.max(1, scale);
  const halfVisible = 0.5 / safeScale;
  const safeHalf = halfVisible * clamp(innerFraction, 0.2, 0.95);

  return (
    Math.abs(cursor.x - center.x) <= safeHalf &&
    Math.abs(cursor.y - center.y) <= safeHalf
  );
}

/**
 * If the cursor leaves the inner safe zone, shift focus on that axis only so
 * the cursor sits on the zone edge — no continuous chase while inside.
 */
export function recenterFocusWhenCursorLeavesSafeZone(
  currentFocus: { x: number; y: number },
  cursor: { x: number; y: number },
  scale: number,
  innerFraction: number,
): { x: number; y: number } {
  const safeScale = Math.max(1, scale);
  const halfVisible = 0.5 / safeScale;
  const safeHalf = halfVisible * clamp(innerFraction, 0.2, 0.95);

  let nextX = currentFocus.x;
  let nextY = currentFocus.y;

  if (cursor.x < currentFocus.x - safeHalf) {
    nextX = cursor.x;
  } else if (cursor.x > currentFocus.x + safeHalf) {
    nextX = cursor.x;
  }

  if (cursor.y < currentFocus.y - safeHalf) {
    nextY = cursor.y;
  } else if (cursor.y > currentFocus.y + safeHalf) {
    nextY = cursor.y;
  }

  return clampTargetForScale({ x: nextX, y: nextY }, scale);
}

/**
 * First index whose `t >= time`, or `length` when every sample precedes it.
 *
 * Cursor tracks hold one sample per 60 Hz tick for the whole recording — tens
 * of thousands on a long one — and a planner is rebuilt for every fragment
 * touched by a zoom or crop edit. Scanning the track linearly made that
 * O(recording), so a pointer drag re-walked every sample per event. Ascending
 * `t` is already relied on by `sampleCursorAtTime`.
 */
function lowerBoundByTime(samples: readonly { t: number }[], time: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findActiveClick(
  clicks: MappedPoint[],
  time: number,
  holdSec: number,
): MappedPoint | null {
  for (let i = clicks.length - 1; i >= 0; i -= 1) {
    const click = clicks[i];
    const elapsed = time - click.t;
    if (elapsed < 0) {
      continue;
    }
    if (elapsed <= holdSec) {
      return click;
    }
    break;
  }

  return null;
}

export function createSmartFollowPlanner(
  metadata: RecordingMetadata | null,
  fragment: ZoomFragment,
  toContent: (p: { x: number; y: number }) => { x: number; y: number },
  config: SmartFollowConfig = SMART_FOLLOW_CONFIG,
): SmartFollowPlanner | null {
  if (!metadata || metadata.cursorSamples.length === 0) {
    return null;
  }

  const pad = config.clickHoldSec + 0.25;
  const rangeStart = fragment.start - pad;
  const rangeEnd = fragment.end + pad;

  // Only the window the fragment can actually read is mapped: seek to its
  // first sample, then walk until the range closes.
  const raw = metadata.cursorSamples;
  const samples: MappedPoint[] = [];
  for (let i = lowerBoundByTime(raw, rangeStart); i < raw.length; i += 1) {
    const sample = raw[i];
    if (sample.t > rangeEnd) break;
    const mapped = toContent({ x: sample.x, y: sample.y });
    samples.push({
      t: sample.t,
      x: clamp(mapped.x, 0, 1),
      y: clamp(mapped.y, 0, 1),
    });
  }

  if (samples.length === 0) {
    // The fragment sits outside the track entirely — seed it with the nearest
    // recorded position so the camera has something to hold.
    const index = lowerBoundByTime(raw, fragment.start);
    const fallback = index < raw.length ? raw[index] : raw[raw.length - 1];
    const mapped = toContent({ x: fallback.x, y: fallback.y });
    samples.push({
      t: fragment.start,
      x: clamp(mapped.x, 0, 1),
      y: clamp(mapped.y, 0, 1),
    });
  }

  const clicks: MappedPoint[] = (metadata.cursorClickSamples ?? [])
    .filter((click) => click.t >= rangeStart && click.t <= rangeEnd)
    .map((click) => {
      const mapped = toContent({ x: click.x, y: click.y });
      return {
        t: click.t,
        x: clamp(mapped.x, 0, 1),
        y: clamp(mapped.y, 0, 1),
      };
    })
    .sort((a, b) => a.t - b.t);

  return { config, samples, clicks };
}

export function createSmartFollowRuntime(initialCenter: {
  x: number;
  y: number;
}): SmartFollowRuntime {
  return {
    committedTarget: { x: initialCenter.x, y: initialCenter.y },
  };
}

export type SmartFollowStepInput = {
  planner: SmartFollowPlanner;
  runtime: SmartFollowRuntime;
  motionState: ZoomMotionState;
  cursor: { x: number; y: number };
  time: number;
  scale: number;
  dt: number;
  fragment: ZoomFragment;
  /** @deprecated kept for call-site compat; safe-zone uses one fraction. */
  phase?: "ease-in" | "plateau";
  followSpringStiffness: number;
  springZeta: number;
  maxVelocity: number;
};

const FOLLOW_PAN_SNAP_EPS = 2e-5;
const FOLLOW_VELOCITY_SNAP_EPS = 0.028;

function stepSpringMotion(
  state: ZoomMotionState,
  target: { x: number; y: number },
  dtSeconds: number,
  stiffness: number,
  dampingRatio: number,
  maxVelocity: number,
): ZoomMotionState {
  const safeDt = Math.max(1e-6, Math.min(dtSeconds, 0.05));
  const omega = stiffness;
  const zeta = dampingRatio;

  const dx = target.x - state.x;
  const dy = target.y - state.y;

  const ax = omega * omega * dx - 2 * zeta * omega * state.vx;
  const ay = omega * omega * dy - 2 * zeta * omega * state.vy;

  let newVx = clamp(state.vx + ax * safeDt, -maxVelocity, maxVelocity);
  let newVy = clamp(state.vy + ay * safeDt, -maxVelocity, maxVelocity);
  let newX = clamp(state.x + newVx * safeDt, 0, 1);
  let newY = clamp(state.y + newVy * safeDt, 0, 1);

  // Overdamped springs shouldn't reverse past the target when it moves every
  // sample (ease curves / relocating focus) — that reads as a hard brake.
  if (zeta >= 1) {
    if ((state.x <= target.x && newX > target.x) || (state.x >= target.x && newX < target.x)) {
      newX = target.x;
      newVx = 0;
    }
    if ((state.y <= target.y && newY > target.y) || (state.y >= target.y && newY < target.y)) {
      newY = target.y;
      newVy = 0;
    }
  }

  return { x: newX, y: newY, vx: newVx, vy: newVy };
}

function clampMotionToScale(
  state: ZoomMotionState,
  scale: number,
): ZoomMotionState {
  const c = clampTargetForScale(state, scale);
  return { x: c.x, y: c.y, vx: state.vx, vy: state.vy };
}

export function stepSmartFollowCursor(input: SmartFollowStepInput): {
  motionState: ZoomMotionState;
  runtime: SmartFollowRuntime;
} {
  const {
    planner,
    runtime,
    motionState,
    cursor,
    time,
    scale,
    dt,
    followSpringStiffness,
    springZeta,
    maxVelocity,
  } = input;

  const config = planner.config;
  const innerFraction = config.safeZoneInnerFraction;
  const click = findActiveClick(planner.clicks, time, config.clickHoldSec);

  // Logical focus: click bias, else safe-zone recenter vs committed focus.
  const panTarget = click
    ? clampTargetForScale({ x: click.x, y: click.y }, scale)
    : recenterFocusWhenCursorLeavesSafeZone(
        runtime.committedTarget,
        cursor,
        scale,
        innerFraction,
      );

  const nextRuntime: SmartFollowRuntime = {
    committedTarget: { x: panTarget.x, y: panTarget.y },
  };

  const stiffness = click
    ? followSpringStiffness * 1.35
    : followSpringStiffness;

  let next = stepSpringMotion(
    motionState,
    panTarget,
    dt,
    stiffness,
    springZeta,
    maxVelocity,
  );

  if (
    Math.hypot(panTarget.x - next.x, panTarget.y - next.y) <
      FOLLOW_PAN_SNAP_EPS &&
    Math.hypot(next.vx, next.vy) < FOLLOW_VELOCITY_SNAP_EPS
  ) {
    next = { x: panTarget.x, y: panTarget.y, vx: 0, vy: 0 };
  }

  next = clampMotionToScale(next, scale);

  return { motionState: next, runtime: nextRuntime };
}

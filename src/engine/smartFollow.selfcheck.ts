/**
 * Runnable check for follow-cursor safe-zone + spring. Run:
 *   node --experimental-strip-types src/engine/smartFollow.selfcheck.ts
 */
import {
  SMART_FOLLOW_CONFIG,
  createSmartFollowPlanner,
  createSmartFollowRuntime,
  isCursorInSafeZone,
  recenterFocusWhenCursorLeavesSafeZone,
  stepSmartFollowCursor,
  type MappedPoint,
  type SmartFollowPlanner,
} from "./smartFollowCursor.ts";
import type {
  RecordingMetadata,
  ZoomFragment,
  ZoomMotionState,
} from "./zoomMotion.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const fragment: ZoomFragment = {
  id: "z",
  start: 0,
  end: 5,
  mode: "follow-cursor",
  targetScale: 2,
  easeIn: 0.5,
  easeOut: 0.5,
  damping: 4,
};

const planner: SmartFollowPlanner = {
  config: { safeZoneInnerFraction: 0.5, clickHoldSec: 0.4 },
  samples: [
    { t: 0, x: 0.5, y: 0.5 },
    { t: 5, x: 0.5, y: 0.5 },
  ],
  clicks: [],
};

{
  const focus = { x: 0.5, y: 0.5 };
  assert(
    isCursorInSafeZone({ x: 0.52, y: 0.5 }, focus, 2, 0.5),
    "cursor near center stays in safe zone",
  );
  assert(
    !isCursorInSafeZone({ x: 0.2, y: 0.5 }, focus, 2, 0.5),
    "cursor near edge leaves safe zone",
  );

  const recentered = recenterFocusWhenCursorLeavesSafeZone(
    focus,
    { x: 0.2, y: 0.5 },
    2,
    0.5,
  );
  assert(
    recentered.x < 0.5 && Math.abs(recentered.y - 0.5) < 1e-9,
    "recenter only moves the axis that left",
  );
}

{
  // Safe-zone must use committed focus, not spring mid-position: while the
  // spring is catching up, a cursor still inside the committed zone must not
  // retarget / reverse the pan (hard brake).
  let runtime = createSmartFollowRuntime({ x: 0.5, y: 0.5 });
  let motion: ZoomMotionState = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
  const dt = 1 / 120;

  // Cursor leaves → commit toward left.
  for (let i = 0; i < 8; i += 1) {
    const stepped = stepSmartFollowCursor({
      planner,
      runtime,
      motionState: motion,
      cursor: { x: 0.15, y: 0.5 },
      time: i * dt,
      scale: 2,
      dt,
      fragment,
      followSpringStiffness: 8,
      springZeta: 1.05,
      maxVelocity: 3.4,
    });
    motion = stepped.motionState;
    runtime = stepped.runtime;
  }
  assert(runtime.committedTarget.x < 0.45, "left exit commits leftward focus");
  const committedX = runtime.committedTarget.x;

  // Cursor returns inside committed safe zone while spring still lagging:
  // committed focus must hold (no snap-back hard brake).
  const midSpringX = motion.x;
  assert(midSpringX > committedX + 0.01, "spring still lagging behind commit");
  const stepped = stepSmartFollowCursor({
    planner,
    runtime,
    motionState: motion,
    cursor: { x: committedX + 0.02, y: 0.5 },
    time: 1,
    scale: 2,
    dt,
    fragment,
    followSpringStiffness: 8,
    springZeta: 1.05,
    maxVelocity: 3.4,
  });
  assert(
    Math.abs(stepped.runtime.committedTarget.x - committedX) < 1e-9,
    "in-zone: committed focus must not retarget to spring mid-position",
  );
}

{
  // The planner slices its sample window by binary search instead of scanning
  // the whole track. Equivalence with the old filter is the entire contract —
  // a range that starts one sample late silently changes the baked motion.
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const identity = (p: { x: number; y: number }) => p;

  // 100 s at 60 Hz — the shape of a real track, big enough that an off-by-one
  // in the search shows up.
  const cursorSamples = Array.from({ length: 6000 }, (_, i) => ({
    t: i / 60,
    x: clamp01(i / 6000),
    y: clamp01(1 - i / 6000),
  }));
  const metadata: RecordingMetadata = {
    schemaVersion: 2,
    sourceWidth: 1920,
    sourceHeight: 1080,
    cursorSamples,
  };

  /** What the pre-binary-search implementation produced, verbatim. */
  const byLinearScan = (frag: ZoomFragment): MappedPoint[] => {
    const pad = SMART_FOLLOW_CONFIG.clickHoldSec + 0.25;
    const rangeStart = frag.start - pad;
    const rangeEnd = frag.end + pad;
    const out: MappedPoint[] = [];
    for (const s of cursorSamples) {
      if (s.t < rangeStart || s.t > rangeEnd) continue;
      const m = identity({ x: s.x, y: s.y });
      out.push({ t: s.t, x: clamp01(m.x), y: clamp01(m.y) });
    }
    return out;
  };

  const range = (start: number, end: number): ZoomFragment => ({
    id: `r-${start}-${end}`,
    start,
    end,
    mode: "follow-cursor",
    targetScale: 2,
    easeIn: 0.4,
    easeOut: 0.4,
    damping: 4,
  });

  const assertSameSlice = (frag: ZoomFragment, label: string) => {
    const planned = createSmartFollowPlanner(metadata, frag, identity);
    assert(planned !== null, `${label}: planner exists`);
    const expected = byLinearScan(frag);
    // Empty ranges take the seeded-fallback branch, which the linear scan
    // reference does not model; those are asserted separately below.
    if (expected.length === 0) return;
    assert(
      planned!.samples.length === expected.length,
      `${label}: ${planned!.samples.length} samples, expected ${expected.length}`,
    );
    for (let i = 0; i < expected.length; i += 1) {
      const a = planned!.samples[i];
      const b = expected[i];
      assert(
        a.t === b.t && a.x === b.x && a.y === b.y,
        `${label}: sample ${i} differs`,
      );
    }
  };

  assertSameSlice(range(40, 55), "mid-track fragment");
  assertSameSlice(range(-5, 3), "fragment starting before the first sample");
  assertSameSlice(range(97, 120), "fragment ending after the last sample");
  assertSameSlice(range(0, 100), "fragment spanning the whole track");
  // Boundary: `pad` is 0.65 s, so these straddle exact sample timestamps.
  assertSameSlice(range(10, 10.0166666), "sub-frame fragment");
  assertSameSlice(range(0.65, 1.3), "fragment whose pad lands on sample 0");

  {
    // Entirely past the track: the fallback seeds one sample at fragment.start
    // from the nearest recorded position (the last one here).
    const frag = range(500, 510);
    const planned = createSmartFollowPlanner(metadata, frag, identity);
    assert(planned !== null, "past-track: planner exists");
    assert(planned!.samples.length === 1, "past-track: seeded with one sample");
    const last = cursorSamples[cursorSamples.length - 1];
    assert(
      planned!.samples[0].t === frag.start &&
        planned!.samples[0].x === last.x &&
        planned!.samples[0].y === last.y,
      "past-track: seed uses the last recorded position",
    );
  }

  {
    // Entirely before the track: the seed is the first sample at or after
    // fragment.start, i.e. sample 0.
    const frag = range(-50, -40);
    const planned = createSmartFollowPlanner(metadata, frag, identity);
    assert(planned !== null, "pre-track: planner exists");
    assert(planned!.samples.length === 1, "pre-track: seeded with one sample");
    assert(
      planned!.samples[0].t === frag.start &&
        planned!.samples[0].x === cursorSamples[0].x &&
        planned!.samples[0].y === cursorSamples[0].y,
      "pre-track: seed uses the first recorded position",
    );
  }

  {
    // The crop mapping still runs over every sliced sample.
    const shift = (p: { x: number; y: number }) => ({ x: p.x * 0.5, y: p.y });
    const planned = createSmartFollowPlanner(metadata, range(40, 55), shift);
    const expected = byLinearScan(range(40, 55));
    assert(planned !== null, "mapped: planner exists");
    for (let i = 0; i < expected.length; i += 1) {
      assert(
        Math.abs(planned!.samples[i].x - expected[i].x * 0.5) < 1e-12,
        `mapped: sample ${i} not passed through toContent`,
      );
    }
  }

  {
    // An empty track has no window to search and no seed to fall back on.
    const empty: RecordingMetadata = { ...metadata, cursorSamples: [] };
    assert(
      createSmartFollowPlanner(empty, range(0, 5), identity) === null,
      "empty track yields no planner",
    );
  }
}

console.log("smartFollow.selfcheck: ok");

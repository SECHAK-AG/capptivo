/**
 * Runnable check for follow-cursor safe-zone + spring. Run:
 *   node --experimental-strip-types src/engine/smartFollow.selfcheck.ts
 */
import {
  createSmartFollowRuntime,
  isCursorInSafeZone,
  recenterFocusWhenCursorLeavesSafeZone,
  stepSmartFollowCursor,
  type SmartFollowPlanner,
} from "./smartFollowCursor.ts";
import type { ZoomFragment, ZoomMotionState } from "./zoomMotion.ts";

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

console.log("smartFollow.selfcheck: ok");

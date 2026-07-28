/**
 * Runnable check for cursor spring chase + click freeze. Run:
 *   node --experimental-strip-types src/engine/cursorMotion.selfcheck.ts
 */
import {
  CURSOR_CLICK_FREEZE_S,
  CursorMotionState,
  cursorBounceScale,
  nearCursorClick,
} from "./cursorMotion.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const motion = new CursorMotionState();
motion.snapTo(0.2, 0.5, 0);

// Spring should glide toward the target, not teleport, at mid smoothness.
let pos = { x: 0.2, y: 0.5 };
for (let i = 1; i <= 8; i += 1) {
  const t = i / 60;
  const out = motion.update({ x: 0.8, y: 0.5 }, t, {
    smoothness: 0.65,
    sway: 0,
    motionBlur: 0.35,
    freeze: false,
    nearClick: false,
  });
  pos = { x: out.x, y: out.y };
}
assert(pos.x > 0.25 && pos.x < 0.8, `spring mid-chase x=${pos.x}`);
assert(Math.abs(pos.y - 0.5) < 0.02, "spring keeps y");

// Seek backwards snaps.
{
  const out = motion.update({ x: 0.1, y: 0.2 }, 0.02, {
    smoothness: 0.65,
    sway: 0,
    motionBlur: 0.35,
    freeze: false,
    nearClick: false,
  });
  assert(
    Math.abs(out.x - 0.1) < 1e-9 && Math.abs(out.y - 0.2) < 1e-9,
    "seek snaps to target",
  );
}

// Click freeze snaps even with high smoothness.
{
  motion.snapTo(0.4, 0.4, 1);
  // Pull away a bit first.
  motion.update({ x: 0.7, y: 0.4 }, 1 + 1 / 60, {
    smoothness: 0.9,
    sway: 0,
    motionBlur: 0,
    freeze: false,
    nearClick: false,
  });
  const clickT = 1.2;
  const out = motion.update({ x: 0.55, y: 0.55 }, clickT, {
    smoothness: 0.9,
    sway: 0.5,
    motionBlur: 0.5,
    freeze: false,
    nearClick: true,
  });
  assert(
    Math.abs(out.x - 0.55) < 1e-9 && Math.abs(out.y - 0.55) < 1e-9,
    "near-click freezes on the recorded tip",
  );
  assert(out.rotation === 0, "near-click clears sway rotation");
}

assert(nearCursorClick([{ start: 1, end: 1.1 }], 1.05), "inside freeze window");
assert(
  !nearCursorClick([{ start: 1, end: 1.1 }], 1 + CURSOR_CLICK_FREEZE_S + 0.05),
  "outside freeze window",
);

{
  const b = cursorBounceScale([{ start: 0, end: 0.05 }], 0.175, 0.2);
  assert(b < 1 && b >= 0.72, `bounce mid-pulse scale=${b}`);
  assert(cursorBounceScale([{ start: 0, end: 0.05 }], 0.5, 0.2) === 1, "bounce done");
}

console.log("cursorMotion.selfcheck: ok");

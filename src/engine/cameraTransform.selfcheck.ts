/**
 * Runnable check for the editor camera. Run:
 *   node --experimental-strip-types src/engine/cameraTransform.selfcheck.ts
 *
 * The bug this guards: zoom focus is normalized to the **recording rect**, but
 * was being consumed as if it were normalized to the **stage**. Those agree
 * only at dead centre, so the error was invisible on a centred zoom and grew
 * toward the edges — multiplied by scale. Anything anchored to the recording,
 * the cursor above all, drifted off the pixel it pointed at.
 */
import {
  applyCameraTransform,
  CAMERA_IDENTITY,
  computeCameraTransform,
} from "./cameraTransform.ts";
import { clampTargetForScale } from "./zoomMotion.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const STAGE = { width: 1920, height: 1080 };
// A 3024x1964 recording on a 16:9 stage: height-limited, so it is inset
// horizontally. Exactly the geometry where rect-NDC ≠ stage-NDC.
const RECT = { x: 128.5, y: 0, width: 1663, height: 1080 };

function camera(focus: { x: number; y: number }, scale: number) {
  return computeCameraTransform({
    stageWidth: STAGE.width,
    stageHeight: STAGE.height,
    videoRect: RECT,
    focus,
    scale,
  });
}

/** Where recording-rect NDC (u, v) lands on the stage under `transform`. */
function contentOnStage(
  transform: { scale: number; x: number; y: number },
  u: number,
  v: number,
) {
  return applyCameraTransform(transform, {
    x: RECT.x + u * RECT.width,
    y: RECT.y + v * RECT.height,
  });
}

// --- identity ---------------------------------------------------------------
// The epsilon is deliberately tiny rather than a visible dead-band: an envelope
// ramping through it must not pop from "no transform" to a real one.
for (const scale of [1, 0.5, 1 + 1e-9]) {
  const t = camera({ x: 0.3, y: 0.7 }, scale);
  assert(
    t.scale === CAMERA_IDENTITY.scale && t.x === 0 && t.y === 0,
    `scale ${scale} → identity`,
  );
}

// --- the ramp out of 1x is continuous, with no pop --------------------------
// Centring the focus is a jump *unless* the focus itself converges to the rect
// centre as scale → 1. `clampTargetForScale` — which every baked keyframe goes
// through — guarantees exactly that, and `getCompositionLayout` centres the
// rect on the stage. Together the transform tends to identity smoothly.
{
  // Worst case: a focus hard against the corner, which the clamp drags all the
  // way from the centre as the window opens.
  const rawFocus = { x: 0.05, y: 0.95 };
  const step = 0.005;
  let previous = { x: 0, y: 0 };
  let worst = 0;
  let travel = 0;
  for (let scale = 1; scale <= 1.5 + 1e-9; scale += step) {
    const t = camera(clampTargetForScale(rawFocus, scale), scale);
    const moved = Math.hypot(t.x - previous.x, t.y - previous.y);
    if (scale > 1) {
      worst = Math.max(worst, moved);
      travel += moved;
    }
    previous = { x: t.x, y: t.y };
  }
  // Measured ~5.4px; a discontinuity at the epsilon would be hundreds.
  assert(
    worst < 12,
    `camera must ease out of 1x, not jump (worst step ${worst.toFixed(1)}px)`,
  );
  assert(
    travel > 100,
    "fixture must actually travel, or continuity is vacuous",
  );
}

// --- the focus point lands on the stage centre, at every scale --------------
for (const scale of [1.2, 1.5, 2, 3]) {
  for (const focus of [
    { x: 0.5, y: 0.5 },
    { x: 0.1, y: 0.9 },
    { x: 0.85, y: 0.2 },
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]) {
    const t = camera(focus, scale);
    const p = contentOnStage(t, focus.x, focus.y);
    assert(
      Math.abs(p.x - STAGE.width / 2) < 1e-9 &&
        Math.abs(p.y - STAGE.height / 2) < 1e-9,
      `focus ${focus.x},${focus.y} at ${scale}x must sit on the stage centre`,
    );
  }
}

// --- regression guard: rect-NDC is NOT stage-NDC ----------------------------
// The old code did `pivot = focus * stageSize`. Assert the fixture is one where
// that lands on a different content point, so a relapse fails loudly.
{
  const focus = { x: 0.8, y: 0.5 };
  const asRectNdc = RECT.x + focus.x * RECT.width;
  const asStageNdc = focus.x * STAGE.width;
  assert(
    Math.abs(asRectNdc - asStageNdc) > 50,
    "fixture must expose the rect-NDC vs stage-NDC confusion",
  );
  // And the content point the stage-NDC reading would have centred is a
  // *different* part of the recording — this is the drift users saw.
  const wrongU = (asStageNdc - RECT.x) / RECT.width;
  assert(
    Math.abs(wrongU - focus.x) > 0.02,
    "stage-NDC reading centres the wrong part of the recording",
  );
}

// --- video and cursor cannot diverge ---------------------------------------
// Both are children of the camera, so they are the same transform by
// construction. What is worth asserting is the consequence: the on-stage gap
// between two content points scales by exactly `scale` and nothing else.
for (const scale of [1.5, 2, 3]) {
  const t = camera({ x: 0.35, y: 0.6 }, scale);
  const a = contentOnStage(t, 0.2, 0.2);
  const b = contentOnStage(t, 0.7, 0.9);
  const expectedDx = (0.7 - 0.2) * RECT.width * scale;
  const expectedDy = (0.9 - 0.2) * RECT.height * scale;
  assert(
    Math.abs(b.x - a.x - expectedDx) < 1e-9 &&
      Math.abs(b.y - a.y - expectedDy) < 1e-9,
    `content geometry scales uniformly at ${scale}x`,
  );
}

// --- scale-about-focus expressed as scale-then-translate --------------------
{
  const focus = { x: 0.42, y: 0.61 };
  const scale = 1.8;
  const t = camera(focus, scale);
  const focusStagePxX = RECT.x + focus.x * RECT.width;
  const focusStagePxY = RECT.y + focus.y * RECT.height;
  assert(
    Math.abs(t.x - (STAGE.width / 2 - focusStagePxX * scale)) < 1e-9 &&
      Math.abs(t.y - (STAGE.height / 2 - focusStagePxY * scale)) < 1e-9,
    "transform equals stage-centre minus scaled focus point",
  );
}

// --- double-zoom placement must diverge (guards the guard) -----------------
// Positioning the tip in already-zoomed coords *and* parenting under the
// camera is the classic "flies to a corner when zoomed" failure. Assert that
// bug is loud, so a future selfcheck that accidentally used it would notice.
{
  const scale = 2;
  const tip = { x: 0.78, y: 0.11 };
  const t = camera(tip, scale);
  const local = {
    x: RECT.x + tip.x * RECT.width,
    y: RECT.y + tip.y * RECT.height,
  };
  const right = applyCameraTransform(t, local);
  const wrong = applyCameraTransform(t, {
    x: local.x * scale,
    y: local.y * scale,
  });
  assert(
    Math.hypot(wrong.x - right.x, wrong.y - right.y) > 100,
    "double-scaled placement must diverge hard from the correct tip",
  );
  assert(
    Math.abs(right.x - STAGE.width / 2) < 1e-9 &&
      Math.abs(right.y - STAGE.height / 2) < 1e-9,
    "focus===tip lands on stage centre",
  );
}

{
  const focus = { x: 0.8, y: 0.3 };
  const S = 2.5;
  const focusStageX = RECT.x + focus.x * RECT.width;
  const focusStageY = RECT.y + focus.y * RECT.height;
  for (const progress of [0.25, 0.5, 0.75, 1]) {
    const scale = 1 + (S - 1) * progress;
    const t = computeCameraTransform({
      stageWidth: STAGE.width,
      stageHeight: STAGE.height,
      videoRect: RECT,
      focus,
      scale,
      targetScale: S,
    });
    const expectedX = progress * (STAGE.width / 2 - focusStageX * S);
    const expectedY = progress * (STAGE.height / 2 - focusStageY * S);
    assert(
      Math.abs(t.scale - scale) < 1e-9 &&
        Math.abs(t.x - expectedX) < 1e-6 &&
        Math.abs(t.y - expectedY) < 1e-6,
      `fixed-focus ease-in at p=${progress}: got (${t.x},${t.y}) want (${expectedX},${expectedY})`,
    );
  }
  // Mid ease-in must NOT equal classic scale-about-focus (that slides harder).
  {
    const scale = 1 + (S - 1) * 0.5;
    const fixedFocus = computeCameraTransform({
      stageWidth: STAGE.width,
      stageHeight: STAGE.height,
      videoRect: RECT,
      focus,
      scale,
      targetScale: S,
    });
    const classic = computeCameraTransform({
      stageWidth: STAGE.width,
      stageHeight: STAGE.height,
      videoRect: RECT,
      focus,
      scale,
    });
    assert(
      Math.hypot(fixedFocus.x - classic.x, fixedFocus.y - classic.y) > 20,
      "fixed-focus mid ease-in must differ from classic centre-on-focus",
    );
  }
}

console.log("cameraTransform.selfcheck: ok");

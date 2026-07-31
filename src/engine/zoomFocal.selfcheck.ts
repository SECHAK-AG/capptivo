/** Selfcheck: zoom clamp and fixed-rect motion. */

import {
  clampTargetForScale,
  computeSceneZoomRenderCenter,
  computeSceneZoomScale,
  computeZoomEnvelope,
  computeZoomKeyframes,
  type RecordingMetadata,
  type ZoomFragment,
} from "./zoomMotion.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function inValidRange(pan: { x: number; y: number }, scale: number): boolean {
  const clamped = clampTargetForScale(pan, scale);
  return (
    Math.abs(clamped.x - pan.x) < 1e-9 && Math.abs(clamped.y - pan.y) < 1e-9
  );
}

// --- unit: clamp ---
assert(
  clampTargetForScale({ x: 0.1, y: 0.9 }, 1).x === 0.5,
  "1× clamp → center",
);
assert(
  clampTargetForScale({ x: 0.1, y: 0.9 }, 2).x === 0.25,
  "2× clamp floors at 0.25",
);
assert(
  clampTargetForScale({ x: 0.1, y: 0.9 }, 2).y === 0.75,
  "2× clamp caps at 0.75",
);

// --- scene fixed-rect: hyperbolic scale + focal lerp ---
const fixedRect = { x: 0.1, y: 0.2, width: 0.4, height: 0.35 };
const fixed: ZoomFragment = {
  id: "fixed-scene",
  start: 0,
  end: 2,
  mode: "fixed-rect",
  fixedRect,
  targetScale: 2,
  easeIn: 0.5,
  easeOut: 0.3,
  damping: 4,
};
{
  const midEnv = 0.5;
  const S = 1 / Math.max(fixedRect.width, fixedRect.height);
  const hyper = computeSceneZoomScale(fixed, midEnv);
  const linear = 1 + (S - 1) * midEnv;
  // View-rect ramp sits below the linear scale mid-way (shrinks the visible
  // window evenly); endpoints still match 1 and S.
  assert(
    hyper < linear - 0.01,
    "fixed-rect scene scale is hyperbolic (below linear mid)",
  );
  assert(
    Math.abs(computeSceneZoomScale(fixed, 0) - 1) < 1e-9,
    "scene scale starts at 1",
  );
  assert(
    Math.abs(computeSceneZoomScale(fixed, 1) - S) < 1e-6,
    "scene scale ends at S",
  );

  const focus = {
    x: fixedRect.x + fixedRect.width / 2,
    y: fixedRect.y + fixedRect.height / 2,
  };
  const midFocal = computeSceneZoomRenderCenter(fixed, focus, hyper, midEnv);
  const expectedX = 0.5 + (focus.x - 0.5) * midEnv;
  assert(
    Math.abs(midFocal.x - expectedX) < 0.02,
    "mid focal lerps center→focus",
  );
  assert(inValidRange(midFocal, hyper), "mid focal stays in crop");

  const startFocal = computeSceneZoomRenderCenter(fixed, focus, 1, 0);
  assert(startFocal.x === 0.5 && startFocal.y === 0.5, "env=0 focal = center");
}

// --- baked fixed-rect keyframes: pan lerps with envelope (no snap crop) ---
{
  const keys = computeZoomKeyframes(fixed, null, 60);
  assert(Math.abs(keys[0]!.x - 0.5) < 0.02, "fixed bake: start ~center at 1×");
  assert(
    Math.abs(keys[0]!.scale - 1) < 1e-6,
    "fixed bake: start scale is 1",
  );
  // Fixed-rect may focus onto composition padding (outside recording 0–1);
  // follow-cursor still uses clampTargetForScale to avoid black void.
  const mid = keys.find((k) => {
    const env = computeZoomEnvelope(fixed, k.t);
    return env > 0.45 && env < 0.55;
  });
  assert(mid != null, "fixed bake: mid ease-in sample");
  const focus = {
    x: fixedRect.x + fixedRect.width / 2,
    y: fixedRect.y + fixedRect.height / 2,
  };
  const midEnv = computeZoomEnvelope(fixed, mid!.t);
  // Mid ease-in must lerp centre→rect with the envelope — snapping pan to the
  // rect while scale is still climbing reads as a hard crop / new video.
  const expected = {
    x: 0.5 + (focus.x - 0.5) * midEnv,
    y: 0.5 + (focus.y - 0.5) * midEnv,
  };
  assert(
    Math.abs(mid!.x - expected.x) < 0.02 &&
      Math.abs(mid!.y - expected.y) < 0.02,
    `fixed bake: mid pan should lerp with envelope (got ${mid!.x},${mid!.y} want ${expected.x},${expected.y})`,
  );
  const hyper = computeSceneZoomScale(fixed, midEnv);
  assert(
    Math.abs(mid!.scale - hyper) < 0.02,
    `fixed bake: mid scale should be hyperbolic (got ${mid!.scale} want ${hyper})`,
  );
  // Early ease-in: pan must still be near centre (not already on the rect).
  const early = keys.find((k) => {
    const env = computeZoomEnvelope(fixed, k.t);
    return env > 0.08 && env < 0.18;
  });
  assert(early != null, "fixed bake: early ease-in sample");
  const earlyEnv = computeZoomEnvelope(fixed, early!.t);
  assert(
    Math.abs(early!.x - (0.5 + (focus.x - 0.5) * earlyEnv)) < 0.02,
    `fixed bake: early pan must track envelope, not snap (got ${early!.x})`,
  );
  // Plateau: sit on the rect centre at full hyperbolic scale.
  const plateau = keys.find((k) => {
    const env = computeZoomEnvelope(fixed, k.t);
    return env > 0.99;
  });
  assert(plateau != null, "fixed bake: plateau sample");
  assert(
    Math.abs(plateau!.x - focus.x) < 0.02 &&
      Math.abs(plateau!.y - focus.y) < 0.02,
    `fixed bake: plateau pan = rect centre (got ${plateau!.x},${plateau!.y})`,
  );
}

// --- follow-cursor: edge focus still clamped, never black ---
const edgeFocus = { x: 0.08, y: 0.92 };
const metadataEdge: RecordingMetadata = {
  schemaVersion: 2,
  sourceWidth: 1920,
  sourceHeight: 1080,
  cursorSamples: [
    { t: 0, x: edgeFocus.x, y: edgeFocus.y },
    { t: 2, x: edgeFocus.x, y: edgeFocus.y },
  ],
};
const followEdge: ZoomFragment = {
  id: "follow-edge",
  start: 0,
  end: 2,
  mode: "follow-cursor",
  targetScale: 1.4,
  easeIn: 0.4,
  easeOut: 0.25,
  damping: 4,
};
{
  const keys = computeZoomKeyframes(followEdge, metadataEdge, 60);
  for (const k of keys) {
    const env = computeZoomEnvelope(followEdge, k.t);
    const local = k.t - followEdge.start;
    // Ease-in holds full-S focus while scale climbs (fixed-focus camera path).
    const clampScale =
      env < 1 && local < followEdge.easeIn
        ? followEdge.targetScale
        : k.scale;
    assert(
      inValidRange(k, clampScale),
      `edge focus: black void at t=${k.t} pan=(${k.x},${k.y}) scale=${k.scale}`,
    );
  }
  // Smart-follow keeps the cursor inside the frame (safe zone), not snapped
  // onto the clamped cursor. Just assert the plateau moved toward the edge.
  const plateau = keys.find(
    (k) => Math.abs(k.scale - followEdge.targetScale) < 0.02,
  );
  assert(plateau != null, "edge focus: expected plateau sample");
  assert(
    plateau!.x < 0.5 && plateau!.y > 0.5,
    `edge focus: plateau should drift toward edge (got ${plateau!.x},${plateau!.y})`,
  );

  // Ease-in: focus locked on start seed (clamped at full S) — only scale
  // eases. Camera applies progress·finalOffset; pan must not slide.
  const midEase = keys.find((k) => {
    const env = computeZoomEnvelope(followEdge, k.t);
    return env > 0.45 && env < 0.55;
  });
  assert(midEase != null, "follow: mid ease-in sample");
  const fullFocus = clampTargetForScale(edgeFocus, followEdge.targetScale);
  assert(
    Math.abs(midEase!.x - fullFocus.x) < 0.02 &&
      Math.abs(midEase!.y - fullFocus.y) < 0.02,
    `follow ease-in: pan must stay on seed (got ${midEase!.x},${midEase!.y} want ${fullFocus.x},${fullFocus.y})`,
  );
  assert(
    midEase!.x < 0.48 && midEase!.y > 0.52,
    `follow ease-in: seed is off-centre (got ${midEase!.x},${midEase!.y})`,
  );
}

// --- follow-cursor: high-scale ease-in keeps fixed focus (no L/R hunt) ---
{
  const seed = { x: 0.92, y: 0.5 };
  const metadataHi: RecordingMetadata = {
    schemaVersion: 2,
    sourceWidth: 1920,
    sourceHeight: 1080,
    cursorSamples: [
      { t: 0, x: seed.x, y: seed.y },
      { t: 3, x: seed.x, y: seed.y },
    ],
  };
  const followHi: ZoomFragment = {
    id: "follow-hi-scale",
    start: 0,
    end: 3,
    mode: "follow-cursor",
    targetScale: 3,
    easeIn: 0.6,
    easeOut: 0.3,
    damping: 4,
  };
  const keys = computeZoomKeyframes(followHi, metadataHi, 60);
  const focus = clampTargetForScale(seed, followHi.targetScale);
  for (const k of keys) {
    const local = k.t - followHi.start;
    if (local >= followHi.easeIn) continue;
    assert(
      Math.abs(k.x - focus.x) < 0.02 && Math.abs(k.y - focus.y) < 0.02,
      `hi-scale ease-in: focus drifted (t=${k.t} got ${k.x},${k.y} want ${focus.x},${focus.y})`,
    );
  }
}

// --- follow-cursor: ease-in must NOT chase a moving cursor (anti-flicker) ---
{
  const seed = { x: 0.3, y: 0.7 };
  const metadataMoving: RecordingMetadata = {
    schemaVersion: 2,
    sourceWidth: 1920,
    sourceHeight: 1080,
    cursorSamples: [
      { t: 0, x: seed.x, y: seed.y },
      { t: 0.15, x: 0.75, y: 0.2 },
      { t: 0.3, x: 0.2, y: 0.85 },
      { t: 0.45, x: 0.8, y: 0.15 },
      { t: 2, x: 0.55, y: 0.45 },
    ],
  };
  const followMoving: ZoomFragment = {
    id: "follow-moving-easein",
    start: 0,
    end: 2,
    mode: "follow-cursor",
    targetScale: 1.8,
    easeIn: 0.5,
    easeOut: 0.25,
    damping: 4,
  };
  const keys = computeZoomKeyframes(followMoving, metadataMoving, 120);
  const midEase = keys.find((k) => {
    const env = computeZoomEnvelope(followMoving, k.t);
    return env > 0.45 && env < 0.55;
  });
  assert(midEase != null, "moving ease-in: mid sample");
  const focus = clampTargetForScale(seed, followMoving.targetScale);
  assert(
    Math.abs(midEase!.x - focus.x) < 0.02 &&
      Math.abs(midEase!.y - focus.y) < 0.02,
    `moving ease-in: must stay on start seed (got ${midEase!.x},${midEase!.y} want ${focus.x},${focus.y})`,
  );
}

console.log("zoomFocal.selfcheck: ok");

/**
 * Golden vectors for the Rust engine port, produced by the editor's own
 * TypeScript implementation. The Rust tests (`tests/golden.rs`) must reproduce
 * every number here, which is how the port proves it renders what the preview
 * renders.
 *
 * Regenerate after changing any of the source modules below:
 *   node --experimental-strip-types --import ./register.mjs generate.mjs
 * (run from this directory). Inputs are synthetic and seeded, so the output is
 * deterministic and contains no user recording data.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  computeZoomKeyframes,
  computeZoomEnvelope,
  createFullNormToContentNdcFromCrop,
  interpolateZoomKeyframe,
} from "../../../../src/engine/zoomMotion.ts";
import {
  computeCameraTransform,
} from "../../../../src/engine/cameraTransform.ts";
import {
  CursorMotionState,
  cursorBounceScale,
  cursorClickFxProgress,
  nearCursorClick,
  stepSpringValue,
  createSpringState,
  getCursorSpringConfig,
} from "../../../../src/engine/cursorMotion.ts";
import {
  computeFaceCamZoomPresenceScale,
  faceCamShadowPasses,
  getCompositionLayout,
  resolveFaceCamLayout,
} from "../../../../src/engine/editorCanvas.ts";
import { blurRegionPlacement } from "../../../../src/engine/blurRegions.ts";
import { computeCursorLoopReturn } from "../../../../src/engine/cursorOverlay.ts";
import {
  computeExportDimensionsForVideo,
  recordingShadowPasses,
  resolveRecordingLayoutParams,
  resolveStageSize,
  resolveZoomCompositionLayout,
} from "../../../../src/windows/editor/lib/composition.ts";
import { resolveZoomReactiveState } from "../../../../src/windows/editor/render/renderFrame.ts";
import { faceCamFrameAt } from "../../../../src/windows/editor/lib/faceCamSync.ts";
import { resolveActiveCueWords } from "../../../../src/captions/captionTiming.ts";
import { DEFAULT_CAPTION_SETTINGS } from "../../../../src/captions/settings.ts";
import { DEFAULT_CURSOR_SETTINGS } from "../../../../src/engine/cursorOverlay.ts";
import { DEFAULT_LOOK } from "../../../../src/windows/editor/lib/composition.ts";
import { nativeRenderDocument } from "../../../../src/windows/editor/export/nativeDocument.ts";

const outDir = dirname(fileURLToPath(import.meta.url));

/** mulberry32 — tiny seeded PRNG so every run emits identical vectors. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JSON keeps Infinity as a string so Rust can read it back exactly. */
function write(name, value) {
  const json = JSON.stringify(
    value,
    (_k, v) =>
      typeof v === "number" && !Number.isFinite(v)
        ? Number.isNaN(v)
          ? "NaN"
          : v > 0
            ? "Infinity"
            : "-Infinity"
        : v,
  );
  writeFileSync(join(outDir, `${name}.json`), json);
  console.log(`${name}.json (${json.length} bytes)`);
}

// ---------------------------------------------------------------------------
// Synthetic recording: a cursor that moves, rests, clicks and changes shape.
// ---------------------------------------------------------------------------

function syntheticMetadata(seed) {
  const r = rng(seed);
  const samples = [];
  const clicks = [];
  const press = [];
  const shapes = [undefined, "pointer", "text", undefined, "grab"];
  let x = 0.4;
  let y = 0.55;
  let tx = x;
  let ty = y;
  let shape;
  for (let i = 0; i <= 20 * 60; i += 1) {
    const t = i / 60 + (r() - 0.5) * 0.004;
    if (i % 90 === 0) {
      // New destination; occasionally sit still for a while (idle windows).
      if (r() < 0.25) {
        tx = x;
        ty = y;
      } else {
        tx = 0.05 + r() * 0.9;
        ty = 0.05 + r() * 0.9;
      }
      if (r() < 0.4) shape = shapes[Math.floor(r() * shapes.length)];
    }
    x += (tx - x) * 0.08 + (r() - 0.5) * 0.002;
    y += (ty - y) * 0.08 + (r() - 0.5) * 0.002;
    const sample = { t, x, y };
    if (shape) sample.shape = shape;
    samples.push(sample);
    if (i % 137 === 60) {
      clicks.push({ t, x, y });
      press.push({ start: t, end: t + 0.05 + r() * 0.4 });
    }
  }
  // An unclosed hold (button still down when the take stopped).
  press.push({ start: 19.8, end: Number.POSITIVE_INFINITY });
  return {
    schemaVersion: 2,
    sourceWidth: 3024,
    sourceHeight: 1964,
    cursorSamples: samples,
    cursorClickSamples: clicks,
    cursorPressIntervals: press,
  };
}

const metadata = syntheticMetadata(7);
write("metadata", metadata);

// ---------------------------------------------------------------------------
// Composition layout
// ---------------------------------------------------------------------------

const presets = ["recording", "16:9", "16:10", "9:16", "4:3", "1:1", "21:9"];
const layoutCases = [];
for (const presetId of presets) {
  for (const [hasSelectedBackground, hasImageBackground] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    for (const crop of [null, { x: 0.1, y: 0.05, width: 0.7, height: 0.8 }]) {
      for (const sourceVideoSize of [
        { width: 3024, height: 1964 },
        { width: 1920, height: 1080 },
        { width: 1080, height: 1920 },
      ]) {
        const stage = resolveStageSize(presetId, sourceVideoSize);
        const devicePadding = 120;
        const sourceAspect = sourceVideoSize.width / sourceVideoSize.height;
        const params = resolveRecordingLayoutParams({
          presetId,
          sourceAspect,
          sourceVideoSize,
          hasSelectedBackground,
          hasImageBackground,
          devicePadding,
          screenContentCrop: crop,
        });
        const layout = getCompositionLayout(
          params.sourceAspect,
          stage.width,
          stage.height,
          params.devicePadding,
        );
        const zoomLayout = resolveZoomCompositionLayout({
          stageWidth: stage.width,
          stageHeight: stage.height,
          presetId,
          sourceAspect,
          sourceVideoSize,
          hasSelectedBackground,
          hasImageBackground,
          devicePadding,
          screenContentCrop: crop,
        });
        layoutCases.push({
          input: {
            presetId,
            hasSelectedBackground,
            hasImageBackground,
            crop,
            sourceVideoSize,
            sourceAspect,
            devicePadding,
          },
          stage,
          exportDims: computeExportDimensionsForVideo(stage.width, stage.height, 1920),
          gifDims: computeExportDimensionsForVideo(stage.width, stage.height, 1280),
          params,
          layout,
          zoomLayout,
        });
      }
    }
  }
}
write("layout", layoutCases);

// ---------------------------------------------------------------------------
// Zoom motion
// ---------------------------------------------------------------------------

const zoomCases = [
  {
    name: "follow-default",
    fragment: {
      id: "z1", start: 1, end: 7, mode: "follow-cursor", targetScale: 1.8,
      easeIn: 1, easeOut: 1, damping: 4,
    },
    crop: null,
  },
  {
    name: "follow-slow-crop",
    fragment: {
      id: "z2", start: 6.5, end: 13, mode: "follow-cursor", targetScale: 2.4,
      easeIn: 0.6, easeOut: 1.4, damping: 12,
    },
    crop: { x: 0.1, y: 0.05, width: 0.7, height: 0.8 },
  },
  {
    name: "follow-snappy-no-ease",
    fragment: {
      id: "z3", start: 12, end: 16, mode: "follow-cursor", targetScale: 1.5,
      easeIn: 0, easeOut: 0, damping: 1,
    },
    crop: null,
  },
  {
    name: "fixed-frame",
    fragment: {
      id: "z4", start: 2, end: 6, mode: "fixed-rect", fixedMode: "frame", targetScale: 2,
      easeIn: 0.8, easeOut: 0.8, damping: 4,
      fixedRect: { x: 0.55, y: 0.1, width: 0.35, height: 0.35 },
    },
    crop: null,
  },
  {
    name: "fixed-target-crop",
    fragment: {
      id: "z5", start: 14, end: 19.5, mode: "fixed-rect", fixedMode: "target", targetScale: 2,
      easeIn: 1.2, easeOut: 0.5, damping: 4,
      fixedRect: { x: 0.02, y: 0.6, width: 0.5, height: 0.3 },
    },
    crop: { x: 0.05, y: 0.1, width: 0.8, height: 0.85 },
  },
];

const zoomOut = [];
for (const c of zoomCases) {
  const toContent = c.crop ? createFullNormToContentNdcFromCrop(c.crop) : undefined;
  // A padded 16:9 stage with the recording letterboxed inside it.
  const layout = { video: { x: 0.0625, y: 0.1, width: 0.875, height: 0.8 } };
  const stageToRecording = (p) => ({
    x: (p.x - layout.video.x) / Math.max(1e-6, layout.video.width),
    y: (p.y - layout.video.y) / Math.max(1e-6, layout.video.height),
  });
  const keyframes = computeZoomKeyframes(
    c.fragment, metadata, 120, toContent, stageToRecording,
  );
  const samples = [];
  for (let t = c.fragment.start - 0.2; t <= c.fragment.end + 0.2; t += 1 / 37) {
    const k = interpolateZoomKeyframe(keyframes, t);
    samples.push({
      t,
      x: k.x,
      y: k.y,
      scale: k.scale,
      envelope: computeZoomEnvelope(c.fragment, t),
      reactive: resolveZoomReactiveState(
        t >= c.fragment.start && t <= c.fragment.end ? c.fragment : null,
        t,
      ),
    });
  }
  zoomOut.push({ ...c, layout, keyframes, samples });
}
write("zoom", zoomOut);

// ---------------------------------------------------------------------------
// Camera transform, face-cam, shadows, blur regions
// ---------------------------------------------------------------------------

const r = rng(99);
const cameraCases = [];
for (let i = 0; i < 200; i += 1) {
  const input = {
    stageWidth: 1920,
    stageHeight: 1080,
    videoRect: { x: 120 + r() * 40, y: 120, width: 1600 + r() * 80, height: 840 },
    focus: { x: r(), y: r() },
    scale: 1 + r() * 2,
    targetScale: r() < 0.5 ? undefined : 1 + r() * 2.5,
  };
  cameraCases.push({ input, output: computeCameraTransform(input) });
}
write("camera", cameraCases);

const faceCases = [];
const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
for (let i = 0; i < 120; i += 1) {
  const isRound = r() < 0.3;
  const options = {
    shadowIntensity: Math.round(r() * 200),
    forceCircle: isRound,
    cornerRoundness: isRound ? undefined : Math.round(r() * 400),
    widthPx: r() < 0.1 ? undefined : 80 + r() * 1000,
    heightPx: r() < 0.1 ? undefined : 60 + r() * 800,
    corner: corners[i % 4],
    crop: r() < 0.3 ? { x: 0.1, y: 0.2, width: 0.6, height: 0.5 } : null,
    positionOverride: r() < 0.2 ? { x: r() * 1500, y: r() * 800 } : null,
    presenceScale: r() < 0.3 ? 0.35 + r() * 0.65 : undefined,
    marginPx: r() < 0.1 ? undefined : r() * 120,
  };
  const stage = i % 3 === 0 ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
  const layout = resolveFaceCamLayout(1280, 720, stage.w, stage.h, options);
  faceCases.push({
    input: { videoWidth: 1280, videoHeight: 720, width: stage.w, height: stage.h, options },
    layout,
    passes: layout ? faceCamShadowPasses(layout.shadow) : null,
  });
}
write("facecam", faceCases);

const shadowCases = [];
for (const intensity of [0, 1, 50, 75, 100, 150, 200]) {
  for (const shortEdge of [480, 1080, 1440]) {
    shadowCases.push({ intensity, shortEdge, passes: recordingShadowPasses(intensity, shortEdge) });
  }
}
write("shadow", shadowCases);

const presenceCases = [];
for (let i = 0; i <= 40; i += 1) {
  const env = -0.2 + i * 0.035;
  presenceCases.push({ env, min: 0.62, out: computeFaceCamZoomPresenceScale(env, 0.62) });
}
write("presence", presenceCases);

const blurCases = [];
for (let i = 0; i < 80; i += 1) {
  const region = { id: `b${i}`, x: r() * 1.1 - 0.05, y: r() * 1.1 - 0.05, width: r() * 0.5, height: r() * 0.5 };
  const content = i % 2 === 0
    ? { ox: 0, oy: 0, rw: 3024, rh: 1964 }
    : { ox: 302.4, oy: 98.2, rw: 2116.8, rh: 1571.2 };
  const rect = { x: 120, y: 160, width: 1680, height: 760 };
  blurCases.push({ region, content, rect, placement: blurRegionPlacement(region, 3024, 1964, content, rect) });
}
write("blur", blurCases);

// ---------------------------------------------------------------------------
// Face-cam time mapping, loop return, captions
// ---------------------------------------------------------------------------

const faceTimeCases = [];
for (const offsetMs of [null, -2, 250, -400]) {
  for (let t = -0.5; t <= 21; t += 0.37) {
    faceTimeCases.push({ t, offsetMs, duration: 20, frame: faceCamFrameAt(t, offsetMs, 20) });
  }
}
write("facecam_time", faceTimeCases);

const loopCases = [
  { segments: [{ id: "a", start: 0, end: 20 }], duration: 20 },
  { segments: [{ id: "a", start: 1, end: 5 }, { id: "b", start: 7, end: 7.4 }], duration: 20 },
  { segments: [{ id: "a", start: 2, end: 2.0005 }], duration: 20 },
  { segments: [], duration: 12 },
].map((c) => ({ ...c, out: computeCursorLoopReturn(c.segments, c.duration) }));
write("loop_return", loopCases);

function cue(id, startMs, endMs, words) {
  return {
    id,
    startMs,
    endMs,
    text: words.map((w) => w[0]).join(" "),
    words: words.map(([text, s, e], i) => ({ text, startMs: s, endMs: e, leadingSpace: i > 0 })),
  };
}
const cues = [
  cue("c1", 500, 2400, [["Hello", 500, 900], ["there,", 900, 1300], ["this", 1400, 1600], ["is", 1600, 1700], ["Capptivo", 1700, 2400]]),
  cue("c2", 2600, 4100, [["Overlapping", 2600, 3200], ["tokens", 3150, 3600], ["here", 3600, 3600]]),
  { id: "c3", startMs: 4300, endMs: 5200, text: "No word timings at all" },
  cue("c4", 6000, 6900, [["Tail", 6000, 6400], ["end", 6450, 6900]]),
];
const captionCases = [];
for (let ms = 0; ms <= 7600; ms += 23) {
  const res = resolveActiveCueWords(cues, ms);
  captionCases.push({
    timeMs: ms,
    cueId: res ? res.cue.id : null,
    activeWordIndex: res ? res.activeWordIndex : null,
    words: res ? res.words.map((w) => w.text) : null,
  });
}
write("captions", { cues, cases: captionCases });

// ---------------------------------------------------------------------------
// Cursor motion
// ---------------------------------------------------------------------------

const springCases = [];
for (const smoothness of [0, 0.15, 0.45, 0.8, 1]) {
  const state = createSpringState(0);
  const config = getCursorSpringConfig(smoothness);
  const values = [];
  for (let i = 0; i < 120; i += 1) {
    const target = i < 40 ? 1 : i < 80 ? 0.3 : 0.31;
    const dt = i % 7 === 0 ? 1 / 30 : 1 / 60;
    values.push({ target, dt, value: stepSpringValue(state, target, dt, config), velocity: state.velocity });
  }
  springCases.push({ smoothness, config, values });
}
write("spring", springCases);

const motion = new CursorMotionState();
const motionSteps = [];
for (let i = 0; i < 600; i += 1) {
  const t = i / 60 + (i >= 300 && i < 310 ? 0.2 : 0);
  const p = metadata.cursorSamples[Math.min(metadata.cursorSamples.length - 1, i * 2)];
  const opts = {
    smoothness: 0.45,
    sway: i < 300 ? 0 : 0.6,
    motionBlur: 0.15 + (i % 200) / 400,
    freeze: false,
    nearClick: nearCursorClick(metadata.cursorPressIntervals, t),
  };
  motionSteps.push({ t, target: { x: p.x, y: p.y }, opts, out: motion.update({ x: p.x, y: p.y }, t, opts) });
}
write("cursor_motion", motionSteps);

const clickCases = [];
for (let t = 0; t <= 20.2; t += 0.011) {
  clickCases.push({
    t,
    near: nearCursorClick(metadata.cursorPressIntervals, t),
    bounce: cursorBounceScale(metadata.cursorPressIntervals, t, 0.2),
    fx: cursorClickFxProgress(metadata.cursorPressIntervals, t),
  });
}
write("cursor_click", clickCases);

// ---------------------------------------------------------------------------
// The IPC contract: the editor's document builder, serialized the way
// `invoke` does (plain JSON.stringify — Infinity becomes null, undefined
// disappears). Written raw, not through `write()`, on purpose.
// ---------------------------------------------------------------------------

const snapshot = {
  projectId: "2026-01-01-abcdef",
  project: { files: { screen: "screen.mp4" }, capture: { capturedSystemAudio: true } },
  screenUrl: "media://localhost/2026-01-01-abcdef/screen.mp4",
  cameraUrl: "media://localhost/2026-01-01-abcdef/camera.mp4",
  cameraOffsetMs: -2,
  sourceAspect: 3024 / 1964,
  sourceVideoSize: { width: 3024, height: 1964 },
  recordingMetadata: metadata,
  aspectRatioPresetId: "16:9",
  backgroundType: "image",
  backgroundImage: null,
  look: { ...DEFAULT_LOOK },
  cursorSettings: { ...DEFAULT_CURSOR_SETTINGS },
  // `DEFAULT_FACE_CAM` in windows/editor/store.ts (that module needs the app).
  faceCam: {
    isRound: false,
    widthPx: 400,
    heightPx: 300,
    shadowIntensity: 100,
    roundness: 18,
    corner: "bottom-right",
    position: null,
    crop: null,
    mirrored: true,
    marginPx: 48,
  },
  screenContentCrop: { x: 0, y: 0.03, width: 1, height: 0.97 },
  duration: 20,
  segments: [
    { id: "seg-a", start: 0, end: 8.5 },
    { id: "seg-b", start: 10, end: 20 },
  ],
  // A legacy fragment carrying deprecated fields the engine must ignore.
  zoomFragments: [
    ...zoomCases.map((c) => c.fragment),
    { ...zoomCases[0].fragment, id: "legacy", scope: "video", reduceBackgroundPadding: true, paddingReductionAmount: 0.4 },
  ],
  blurRegions: [{ id: "b1", x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
  captions: cues,
  captionSettings: { ...DEFAULT_CAPTION_SETTINGS, enabled: true, wordTextColor: null },
};
const contract = JSON.stringify(nativeRenderDocument(snapshot));
writeFileSync(join(outDir, "document.json"), contract);
console.log(`document.json (${contract.length} bytes)`);

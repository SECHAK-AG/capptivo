/**
 * Runnable check for the lazy zoom keyframe cache. Run:
 *   node --experimental-strip-types src/windows/editor/lib/zoomCache.selfcheck.ts
 *
 * Two bug classes this guards:
 *
 * 1. **Divergent motion.** The cache exists so the render loop only
 *    interpolates. If what it hands back ever differs from a direct
 *    `computeZoomKeyframes`, preview and export drift apart and the baked zoom
 *    stops matching what the user tuned. Every case below compares against the
 *    engine directly rather than against a previous cached answer.
 * 2. **A dropped crop mapping.** Keyframes must be integrated in *cropped*
 *    content space. `resolveZoomPanAtTime`'s own lazy branch cannot see the
 *    crop and would bake an unmapped focus; that is precisely why the lazy
 *    lookup lives in this module instead.
 */

import {
  computeZoomKeyframes,
  createFullNormToContentNdcFromCrop,
  interpolateZoomKeyframe,
  type RecordingMetadata,
  type ScreenContentCropNorm,
  type ZoomFragment,
} from "../../../engine/zoomMotion.ts";

import {
  getZoomPanAtTime,
  invalidateZoomKeyframesCache,
  zoomKeyframeCacheSize,
} from "./zoomCache.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// --- fixtures --------------------------------------------------------------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 60 s at 60 Hz, sweeping diagonally so focus is never trivially centred. */
const cursorSamples = Array.from({ length: 3600 }, (_, i) => ({
  t: i / 60,
  x: clamp01(0.1 + (i / 3600) * 0.8),
  y: clamp01(0.9 - (i / 3600) * 0.8),
}));

const metadata: RecordingMetadata = {
  schemaVersion: 2,
  sourceWidth: 1920,
  sourceHeight: 1080,
  cursorSamples,
  cursorClickSamples: [
    { t: 12, x: 0.3, y: 0.7 },
    { t: 31, x: 0.6, y: 0.4 },
  ],
};

function follow(id: string, start: number, end: number): ZoomFragment {
  return {
    id,
    start,
    end,
    mode: "follow-cursor",
    targetScale: 2,
    easeIn: 0.5,
    easeOut: 0.5,
    damping: 4,
  };
}

/** Three fragments with gaps between them, so "no active fragment" is reachable. */
const fragments: ZoomFragment[] = [
  follow("a", 2, 10),
  follow("b", 20, 32),
  follow("c", 40, 50),
];

const crop: ScreenContentCropNorm = {
  x: 0.1,
  y: 0.05,
  width: 0.7,
  height: 0.8,
};

/** What the engine produces with no cache in the way — the reference answer. */
function directPan(
  fragment: ZoomFragment,
  time: number,
  withCrop: ScreenContentCropNorm | null,
  track: RecordingMetadata | null = metadata,
) {
  const toContent = withCrop
    ? createFullNormToContentNdcFromCrop(withCrop)
    : undefined;
  const keyframes = computeZoomKeyframes(fragment, track, undefined, toContent);
  const k = interpolateZoomKeyframe(keyframes, time);
  return { x: k.x, y: k.y, scale: k.scale };
}

function assertSamePan(
  actual: { x: number; y: number; scale: number },
  expected: { x: number; y: number; scale: number },
  label: string,
): void {
  assert(actual.x === expected.x, `${label}: x ${actual.x} != ${expected.x}`);
  assert(actual.y === expected.y, `${label}: y ${actual.y} != ${expected.y}`);
  assert(
    actual.scale === expected.scale,
    `${label}: scale ${actual.scale} != ${expected.scale}`,
  );
}

/** Times spread across ease-in, plateau and ease-out of each fragment. */
function sampleTimes(f: ZoomFragment): number[] {
  const span = f.end - f.start;
  return [0.05, 0.2, 0.5, 0.8, 0.97].map((u) => f.start + span * u);
}

// --- cases -----------------------------------------------------------------

{
  // Cached motion matches the engine exactly, with no crop.
  invalidateZoomKeyframesCache();
  for (const f of fragments) {
    for (const t of sampleTimes(f)) {
      assertSamePan(
        getZoomPanAtTime(fragments, metadata, null, t),
        directPan(f, t, null),
        `uncropped ${f.id} @${t.toFixed(2)}`,
      );
    }
  }
}

{
  // …and with a crop. This is the regression test for the dropped mapping:
  // integrating in full-file space instead of cropped space lands the camera
  // somewhere else entirely.
  invalidateZoomKeyframesCache();
  let differedFromUncropped = false;
  for (const f of fragments) {
    for (const t of sampleTimes(f)) {
      const actual = getZoomPanAtTime(fragments, metadata, crop, t);
      assertSamePan(actual, directPan(f, t, crop), `cropped ${f.id} @${t.toFixed(2)}`);
      const uncropped = directPan(f, t, null);
      if (actual.x !== uncropped.x || actual.y !== uncropped.y) {
        differedFromUncropped = true;
      }
    }
  }
  assert(
    differedFromUncropped,
    "crop must actually move the focus, or this case proves nothing",
  );
}

{
  // Outside every fragment the camera is neutral.
  invalidateZoomKeyframesCache();
  for (const t of [0, 1.5, 15, 35, 60]) {
    const pan = getZoomPanAtTime(fragments, metadata, null, t);
    assert(
      pan.x === 0.5 && pan.y === 0.5 && pan.scale === 1,
      `no fragment covers ${t}: expected the neutral camera`,
    );
  }
}

{
  // Laziness: after an invalidation, asking for one time integrates one
  // fragment. Eager rebuilds are what made a crop drag unusable.
  invalidateZoomKeyframesCache();
  getZoomPanAtTime(fragments, metadata, null, 5);
  assert(
    zoomKeyframeCacheSize() === 1,
    `one query integrates one fragment, got ${zoomKeyframeCacheSize()}`,
  );

  getZoomPanAtTime(fragments, metadata, null, 25);
  assert(
    zoomKeyframeCacheSize() === 2,
    `a second fragment adds one entry, got ${zoomKeyframeCacheSize()}`,
  );

  // A gap time integrates nothing at all.
  getZoomPanAtTime(fragments, metadata, null, 35);
  assert(
    zoomKeyframeCacheSize() === 2,
    "a time outside every fragment integrates nothing",
  );
}

{
  // Identity reuse: an edit that replaces one fragment keeps the others'
  // cached keyframes, and re-integrates only the one that changed.
  invalidateZoomKeyframesCache();
  getZoomPanAtTime(fragments, metadata, null, 5);
  getZoomPanAtTime(fragments, metadata, null, 25);
  assert(zoomKeyframeCacheSize() === 2, "two fragments warmed");

  const edited = fragments.map((f) =>
    f.id === "b" ? { ...f, targetScale: 2.5 } : f,
  );
  invalidateZoomKeyframesCache();
  getZoomPanAtTime(edited, metadata, null, 5);
  assert(
    zoomKeyframeCacheSize() === 1,
    `untouched "a" keeps its entry and "b" is dropped, got ${zoomKeyframeCacheSize()}`,
  );

  // The edited fragment must reflect the new scale, not the stale bake.
  const editedB = edited.find((f) => f.id === "b")!;
  assertSamePan(
    getZoomPanAtTime(edited, metadata, null, 26),
    directPan(editedB, 26, null),
    "edited fragment re-integrates",
  );
}

{
  // A value-equal crop object must not invalidate: React hands over fresh
  // objects constantly, and dropping the cache for each one is the cost this
  // whole module exists to avoid.
  invalidateZoomKeyframesCache();
  getZoomPanAtTime(fragments, metadata, { ...crop }, 5);
  getZoomPanAtTime(fragments, metadata, { ...crop }, 25);
  assert(zoomKeyframeCacheSize() === 2, "two fragments warmed under a crop");

  invalidateZoomKeyframesCache();
  getZoomPanAtTime(fragments, metadata, { ...crop }, 5);
  assert(
    zoomKeyframeCacheSize() === 2,
    `an equal-valued crop keeps both entries, got ${zoomKeyframeCacheSize()}`,
  );

  // A crop that genuinely moved must drop everything — the mapping feeds every
  // fragment's integration.
  invalidateZoomKeyframesCache();
  getZoomPanAtTime(fragments, metadata, { ...crop, x: crop.x + 0.01 }, 5);
  assert(
    zoomKeyframeCacheSize() === 1,
    `a moved crop drops the other entries, got ${zoomKeyframeCacheSize()}`,
  );
}

{
  // Switching crop off and back on must not serve keyframes baked in the other
  // space — the cheapest way to reintroduce the mapping bug.
  invalidateZoomKeyframesCache();
  const cropped = getZoomPanAtTime(fragments, metadata, crop, 5);

  invalidateZoomKeyframesCache();
  const plain = getZoomPanAtTime(fragments, metadata, null, 5);
  assertSamePan(plain, directPan(fragments[0], 5, null), "crop removed");

  invalidateZoomKeyframesCache();
  const again = getZoomPanAtTime(fragments, metadata, crop, 5);
  assertSamePan(again, cropped, "crop reapplied returns to the cropped bake");
}

{
  // New metadata (cursor.json landing after the project opens) rebakes
  // everything, since every sample feeds the integration.
  invalidateZoomKeyframesCache();
  getZoomPanAtTime(fragments, metadata, null, 5);
  getZoomPanAtTime(fragments, metadata, null, 25);
  assert(zoomKeyframeCacheSize() === 2, "two fragments warmed");

  const reloaded: RecordingMetadata = { ...metadata };
  invalidateZoomKeyframesCache();
  getZoomPanAtTime(fragments, reloaded, null, 5);
  assert(
    zoomKeyframeCacheSize() === 1,
    `fresh metadata drops every entry, got ${zoomKeyframeCacheSize()}`,
  );
}

{
  // Deleting fragments must not leave their keyframes behind.
  invalidateZoomKeyframesCache();
  for (const f of fragments) getZoomPanAtTime(fragments, metadata, null, f.start + 1);
  assert(zoomKeyframeCacheSize() === 3, "all three warmed");

  invalidateZoomKeyframesCache();
  getZoomPanAtTime([fragments[0]], metadata, null, 5);
  assert(
    zoomKeyframeCacheSize() === 1,
    `removed fragments are evicted, got ${zoomKeyframeCacheSize()}`,
  );
}

{
  // Repeated reads on a warm cache stay stable (and never re-integrate).
  invalidateZoomKeyframesCache();
  const first = getZoomPanAtTime(fragments, metadata, null, 6.25);
  for (let i = 0; i < 5; i += 1) {
    assertSamePan(
      getZoomPanAtTime(fragments, metadata, null, 6.25),
      first,
      "warm cache is stable",
    );
  }
  assert(zoomKeyframeCacheSize() === 1, "warm reads integrate nothing new");
}

{
  // Fixed-rect fragments go through the same path, crop mapping included.
  const fixed: ZoomFragment = {
    id: "fixed",
    start: 5,
    end: 12,
    mode: "fixed-rect",
    fixedRect: { x: 0.1, y: 0.2, width: 0.4, height: 0.35 },
    targetScale: 2,
    easeIn: 0.4,
    easeOut: 0.3,
    damping: 4,
  };
  invalidateZoomKeyframesCache();
  for (const t of sampleTimes(fixed)) {
    assertSamePan(
      getZoomPanAtTime([fixed], metadata, crop, t),
      directPan(fixed, t, crop),
      `fixed-rect @${t.toFixed(2)}`,
    );
  }
}

{
  // No cursor track at all: follow-cursor holds centre rather than throwing.
  invalidateZoomKeyframesCache();
  const pan = getZoomPanAtTime(fragments, null, null, 5);
  assertSamePan(pan, directPan(fragments[0], 5, null, null), "null metadata");
}

console.log("zoomCache.selfcheck: ok");

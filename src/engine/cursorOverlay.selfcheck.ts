/**
 * Runnable check for cursor placement. Run:
 *   node --experimental-strip-types src/engine/cursorOverlay.selfcheck.ts
 */
import {
  assertCursorDefaults,
  DEFAULT_CURSOR_SETTINGS,
  parseCursorSettings,
  sampleSmoothedCursorAtTime,
} from "./cursorOverlay.ts";
import type { RecordingMetadata } from "./zoomMotion.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assertCursorDefaults();
const parsed = parseCursorSettings({ size: 99, style: "nope" });
assert(
  parsed.size === 4 && parsed.style === DEFAULT_CURSOR_SETTINGS.style,
  "parse clamps size and falls back on unknown style",
);
assert(DEFAULT_CURSOR_SETTINGS.style === "tahoe", "default style is tahoe");

// --- smoothing must never move the glyph off the pixel it points at ---------
// The bug this guards: a symmetric Gaussian adds no lag but cuts corners, and
// the sharpest corner in any track is arriving somewhere and stopping — every
// click. Unbounded, that undershoot is ~23px at 1x, and the camera multiplies
// it by the zoom scale, so zoomed clicks land outside their target.
//
// Track: hold, glide across 40% of the screen in 250ms, stop. Click at 0.80s,
// 50ms after arriving — the ordinary case, and the worst one for corner-cutting.
const samples: RecordingMetadata["cursorSamples"] = [];
for (let t = 0; t <= 2; t += 0.008) {
  const x = t < 0.5 ? 0.2 : t < 0.75 ? 0.2 + 0.4 * ((t - 0.5) / 0.25) : 0.6;
  samples.push({ t, x, y: 0.5 });
}
const metadata = { cursorSamples: samples } as RecordingMetadata;

const CLICK_T = 0.8;
for (const strength of [0.25, 0.5, 1]) {
  const p = sampleSmoothedCursorAtTime(metadata, CLICK_T, strength);
  assert(p !== null, "smoothed sampler returns a point");
  const off = Math.hypot(p!.x - 0.6, p!.y - 0.5);
  // 0.0025 is the bound; allow float slop.
  assert(
    off <= 0.0025 + 1e-6,
    `smoothing at strength ${strength} moved the cursor ${off.toFixed(4)} off the recorded sample (bound 0.0025)`,
  );
}

// Smoothing still does its job: mid-glide, where there is no corner to cut, the
// smoothed track stays on the ramp rather than being pinned to the raw sample.
const mid = sampleSmoothedCursorAtTime(metadata, 0.625, 0.5);
assert(
  mid !== null && Math.abs(mid.x - 0.4) < 0.02,
  "mid-glide tracks the ramp",
);

// Below the strength floor the raw track is returned untouched.
const rawPath = sampleSmoothedCursorAtTime(metadata, CLICK_T, 0);
assert(
  rawPath !== null && Math.abs(rawPath.x - 0.6) < 1e-6,
  "strength 0 returns the recorded sample exactly",
);

console.log("cursorOverlay.selfcheck: ok");

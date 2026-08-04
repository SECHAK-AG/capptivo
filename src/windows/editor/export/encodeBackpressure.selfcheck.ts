/** Selfcheck: encode backpressure math. */

import {
  adaptEncodeDepth,
  clampEncodeDepth,
  encodeDepthCeiling,
  ENCODE_DEPTH_MAX,
  ENCODE_DEPTH_MIN,
  seedEncodeDepth,
} from "./encodeBackpressure.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(clampEncodeDepth(1) === ENCODE_DEPTH_MIN, "clamp floors at min");
assert(clampEncodeDepth(99) === ENCODE_DEPTH_MAX, "clamp caps at max");
assert(clampEncodeDepth(4.4) === 4, "clamp rounds");

assert(encodeDepthCeiling(30) === 23, "30fps ceiling ~0.75s → 23");
assert(encodeDepthCeiling(60) === 45, "60fps ceiling ~0.75s → 45");

// 1920×1080 ≈ 2.07 MP → 48/2.07 ≈ 23 at 30fps
assert(seedEncodeDepth(1920, 1080, 30) === 23, "1080p30 seeds ~23");
// Same pixels at 60fps → half via fps scale (23 * 30/60 ≈ 11.5 → 12)
assert(seedEncodeDepth(1920, 1080, 60) === 12, "1080p60 seeds ~12");
assert(
  seedEncodeDepth(1920, 1080, 60) < seedEncodeDepth(1920, 1080, 30),
  "60fps seed must be below 30fps seed",
);
// 3840×2160 ≈ 8.3 MP → 48/8.3 ≈ 5.8 → 6 at 30fps; ~3 at 60fps
assert(seedEncodeDepth(3840, 2160, 30) === 6, "4K30 seeds ~6");
assert(seedEncodeDepth(3840, 2160, 60) === 3, "4K60 seeds ~3");
// Tiny output at 30fps hits ceiling (~23), not global max
assert(seedEncodeDepth(640, 360, 30) === 23, "small@30 hits fps ceiling");
assert(seedEncodeDepth(640, 360, 60) === 45, "small@60 hits 0.75s ceiling");

const budget = 1000 / 30; // ~33.3 ms

assert(
  adaptEncodeDepth({
    depth: 8,
    emaCompositeMs: 5,
    emaEncodeWaitMs: 40,
    frameBudgetMs: budget,
  }) === 7,
  "high encode wait → shrink",
);

assert(
  adaptEncodeDepth({
    depth: 8,
    emaCompositeMs: 40,
    emaEncodeWaitMs: 0,
    frameBudgetMs: budget,
  }) === 7,
  "heavy composite → shrink",
);

assert(
  adaptEncodeDepth({
    depth: 4,
    emaCompositeMs: 5,
    emaEncodeWaitMs: 0,
    frameBudgetMs: budget,
  }) === 5,
  "light composite + idle encode → deepen",
);

assert(
  adaptEncodeDepth({
    depth: 11,
    emaCompositeMs: 5,
    emaEncodeWaitMs: 0,
    frameBudgetMs: budget,
    maxDepth: 12,
  }) === 12,
  "deepen respects fps maxDepth",
);

assert(
  adaptEncodeDepth({
    depth: 12,
    emaCompositeMs: 5,
    emaEncodeWaitMs: 0,
    frameBudgetMs: budget,
    maxDepth: 12,
  }) === 12,
  "never above session maxDepth",
);

assert(
  adaptEncodeDepth({
    depth: 6,
    emaCompositeMs: 15,
    emaEncodeWaitMs: 5,
    frameBudgetMs: budget,
  }) === 6,
  "steady mid load → hold",
);

assert(
  adaptEncodeDepth({
    depth: ENCODE_DEPTH_MIN,
    emaCompositeMs: 50,
    emaEncodeWaitMs: 50,
    frameBudgetMs: budget,
  }) === ENCODE_DEPTH_MIN,
  "never below min",
);

assert(
  adaptEncodeDepth({
    depth: ENCODE_DEPTH_MAX,
    emaCompositeMs: 1,
    emaEncodeWaitMs: 0,
    frameBudgetMs: budget,
  }) === ENCODE_DEPTH_MAX,
  "never above max",
);

console.log("encodeBackpressure.selfcheck: ok");

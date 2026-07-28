/**
 * Runnable check for encode backpressure math. Run:
 *   node --experimental-strip-types src/windows/editor/export/encodeBackpressure.selfcheck.ts
 */
import {
  adaptEncodeDepth,
  clampEncodeDepth,
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

// 1920×1080 ≈ 2.07 MP → 48/2.07 ≈ 23.2 → 23
assert(seedEncodeDepth(1920, 1080) === 23, "1080p seeds ~23");
// 3840×2160 ≈ 8.3 MP → 48/8.3 ≈ 5.8 → 6
assert(seedEncodeDepth(3840, 2160) === 6, "4K seeds ~6");
// Tiny output hits max
assert(seedEncodeDepth(640, 360) === ENCODE_DEPTH_MAX, "small output seeds max");

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

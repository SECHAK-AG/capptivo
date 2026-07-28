/**
 * Runnable check for export loop yield pacing. Run:
 *   node --experimental-strip-types src/windows/editor/export/exportYield.selfcheck.ts
 *
 * The policy is the whole point: too rare and the window freezes for the length
 * of the export, too frequent and every frame pays a timer round-trip. The loop
 * simulation at the end pins the rate, so changing
 * `EXPORT_YIELD_INTERVAL_MS` fails here rather than silently in production.
 */

import {
  EXPORT_YIELD_INTERVAL_MS,
  shouldYieldNow,
} from "./exportYield.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// A fresh loop has just "yielded" — nothing owed yet.
{
  const d = shouldYieldNow(0, 0);
  assert(!d.shouldYield, "no yield at zero elapsed");
  assert(d.nextLastYieldAt === 0, "no yield leaves the mark untouched");
}

// Just under the interval: still no yield, mark unchanged.
{
  const d = shouldYieldNow(EXPORT_YIELD_INTERVAL_MS - 1, 0);
  assert(!d.shouldYield, "no yield just under the interval");
  assert(d.nextLastYieldAt === 0, "sub-interval leaves the mark untouched");
}

// Exactly at the interval: yield, and the mark advances to now.
{
  const d = shouldYieldNow(EXPORT_YIELD_INTERVAL_MS, 0);
  assert(d.shouldYield, "yield at exactly the interval");
  assert(
    d.nextLastYieldAt === EXPORT_YIELD_INTERVAL_MS,
    "yield advances the mark to now",
  );
}

// One very long frame owes exactly one yield, not a backlog of them.
{
  const d = shouldYieldNow(1000, 0);
  assert(d.shouldYield, "a long frame yields");
  assert(d.nextLastYieldAt === 1000, "the mark jumps to now, not by one interval");
}

// The interval is overridable (the loop uses the default; tests do not).
{
  assert(shouldYieldNow(10, 0, 5).shouldYield, "custom interval honoured");
  assert(!shouldYieldNow(4, 0, 5).shouldYield, "custom interval not tripped early");
}

// Non-zero starting mark: elapsed is measured from it, not from zero.
{
  assert(
    !shouldYieldNow(1000 + EXPORT_YIELD_INTERVAL_MS - 1, 1000).shouldYield,
    "elapsed is relative to the previous mark",
  );
  assert(
    shouldYieldNow(1000 + EXPORT_YIELD_INTERVAL_MS, 1000).shouldYield,
    "elapsed reaches the interval relative to the previous mark",
  );
}

// End-to-end pacing: 500 frames at 3 ms each is 1500 ms of work, so the loop
// should hand the thread back about once per interval.
{
  const FRAMES = 500;
  const MS_PER_FRAME = 3;
  let clock = 0;
  let lastYieldAt = 0;
  let yields = 0;

  for (let i = 0; i < FRAMES; i += 1) {
    clock += MS_PER_FRAME;
    const d = shouldYieldNow(clock, lastYieldAt);
    if (d.shouldYield) {
      yields += 1;
      lastYieldAt = d.nextLastYieldAt;
    }
  }

  const expected = Math.floor(
    (FRAMES * MS_PER_FRAME) / EXPORT_YIELD_INTERVAL_MS,
  );
  assert(
    Math.abs(yields - expected) <= 1,
    `expected ~${expected} yields over ${FRAMES * MS_PER_FRAME}ms, got ${yields}`,
  );
  assert(yields > 0, "a long export must yield at least once");
  assert(
    yields < FRAMES / 4,
    `yielding ${yields} times in ${FRAMES} frames is per-frame overhead, not pacing`,
  );
}

// Frames slower than the interval yield every frame — correct, and the reason
// the trigger is wall time rather than a frame count.
{
  let clock = 0;
  let lastYieldAt = 0;
  let yields = 0;
  for (let i = 0; i < 10; i += 1) {
    clock += EXPORT_YIELD_INTERVAL_MS * 2;
    const d = shouldYieldNow(clock, lastYieldAt);
    if (d.shouldYield) {
      yields += 1;
      lastYieldAt = d.nextLastYieldAt;
    }
  }
  assert(yields === 10, `slow frames yield every frame, got ${yields}`);
}

console.log("exportYield.selfcheck: ok");

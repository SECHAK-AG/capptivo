/**
 * Wall-time-triggered yielding for the export frame loop.
 *
 * The loop's `await`s frequently resolve as microtasks rather than macrotasks:
 * decode is prefetched two deep (`sequentialMedia.ts`), and
 * `AdaptiveEncodeQueue.push` only awaits a real encoder promise once the queue
 * is at depth — which, at a 1080p seed of ~23, a composite-bound export never
 * reaches. A microtask checkpoint does not let WebKit paint or handle input, so
 * without an occasional macrotask the window simply stops responding for the
 * length of the export.
 *
 * Frame count is the wrong trigger: per-frame composite cost varies by an order
 * of magnitude between a cached 720p frame and a 4K one, so a fixed count
 * yields far too often on slow frames and far too rarely on fast ones — and the
 * "too rarely" case is the bug. This gates on elapsed wall time instead.
 *
 * Deliberately *not* part of `AdaptiveEncodeQueue`: its EMAs drive the depth
 * heuristic, and yield latency accounted as encode wait would corrupt them.
 */

/** Longest the loop may hold the main thread before handing it back. */
export const EXPORT_YIELD_INTERVAL_MS = 50;

export type YieldDecision = {
  shouldYield: boolean;
  /** Carry into the next call — unchanged when no yield is due. */
  nextLastYieldAt: number;
};

/**
 * Pure decision step, so the pacing policy is testable without a real encoder.
 * `now` and `lastYieldAt` are `performance.now()`-style monotonic milliseconds.
 */
export function shouldYieldNow(
  now: number,
  lastYieldAt: number,
  intervalMs: number = EXPORT_YIELD_INTERVAL_MS,
): YieldDecision {
  if (now - lastYieldAt >= intervalMs) {
    return { shouldYield: true, nextLastYieldAt: now };
  }
  return { shouldYield: false, nextLastYieldAt: lastYieldAt };
}

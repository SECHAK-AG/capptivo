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

/**
 * Hand the main thread back, then resume as soon as the browser will let us.
 *
 * **Not `setTimeout(0)`.** That is what this used to be, and it measured at
 * **218 ms per yield** on a real export — 351 yields burning 76.4 s of a 100.6 s
 * export, 75.9% of wall time, for 24.3 s of actual work. WebKit clamps timer
 * callbacks (nominally to ~1 ms, 4 ms once nested) and throttles them much
 * harder when the window is not frontmost — which an export window rarely is,
 * because the user goes and does something else while it renders. The export
 * was spending four fifths of its life waiting on a timer.
 *
 * A `MessageChannel` message is a macrotask like a timer — so the browser still
 * gets its chance to paint, handle input and run the compositor between frames,
 * which is the whole point of yielding — but it is not a *timer*, so none of the
 * clamping or background throttling applies. This is the same reason React's
 * scheduler is built on `MessageChannel` rather than `setTimeout`.
 *
 * `scheduler.yield()` is the purpose-built API for exactly this and is preferred
 * when the engine has it; it is not in WebKit yet.
 *
 * The channel is created once and reused: allocating one per yield would mean
 * hundreds of ports per export.
 */
type SchedulerWithYield = { yield?: () => Promise<void> };

let channel: MessageChannel | null = null;
const waiting: Array<() => void> = [];

function messageChannelYield(): Promise<void> {
  if (!channel) {
    channel = new MessageChannel();
    // FIFO: the loop yields one at a time, but a queue keeps this correct if a
    // second caller ever overlaps.
    channel.port1.onmessage = () => waiting.shift()?.();
  }
  return new Promise((resolve) => {
    waiting.push(resolve);
    channel!.port2.postMessage(null);
  });
}

export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerWithYield }).scheduler;
  if (typeof scheduler?.yield === "function") {
    return scheduler.yield();
  }
  if (typeof MessageChannel === "function") {
    return messageChannelYield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

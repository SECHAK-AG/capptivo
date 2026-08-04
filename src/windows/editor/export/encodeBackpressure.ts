/**
 * Adaptive encode-queue depth for the WebCodecs export loop.
 *
 * `CanvasSource.add()` captures the canvas synchronously, so the compositor can
 * redraw immediately while encodes finish asynchronously. Depth bounds how many
 * of those in-flight encodes we allow before awaiting the oldest — that is the
 * backpressure valve (memory + error latency).
 *
 * Seed from output megapixels, then tighten for high fps so 60fps does not keep
 * the same in-flight count as 30fps (half the frame budget → less GPU pressure).
 * Adapt ±1 from composite vs encode wait EMAs, never above the fps ceiling.
 *
 * Backpressure awaits promises — never `requestAnimationFrame` (rAF stalls when
 * the window is backgrounded and can starve the encoder).
 */

export const ENCODE_DEPTH_MIN = 2;
export const ENCODE_DEPTH_MAX = 48;

/** Soft cap on in-flight uncompressed frame area (~48 MP total → ~23 at 1080p). */
const TARGET_IN_FLIGHT_MP = 48;
/** Reference fps for depth scaling — above this, shrink in-flight count. */
const REF_FPS = 30;
/** Wall-clock backlog ceiling (~0.75s of frames). */
const QUEUE_SECONDS = 0.75;

const EMA_ALPHA = 0.2;
/** How often depth may change — avoids thrashing every frame. */
const ADAPT_EVERY = 8;

export function clampEncodeDepth(
  n: number,
  max: number = ENCODE_DEPTH_MAX,
): number {
  const hi = Math.max(ENCODE_DEPTH_MIN, Math.min(ENCODE_DEPTH_MAX, max));
  return Math.max(ENCODE_DEPTH_MIN, Math.min(hi, Math.round(n)));
}

/**
 * Hard ceiling from fps: ~0.75s of frames, never above {@link ENCODE_DEPTH_MAX}.
 * 30fps → ~23; 60fps → ~45 (then megapixel / scale caps usually win first).
 */
export function encodeDepthCeiling(fps: number): number {
  return clampEncodeDepth(Math.max(1, fps) * QUEUE_SECONDS);
}

/**
 * Initial queue depth. 1080p30 → ~23; 1080p60 → ~12 (fps scale);
 * 4K → lower from megapixels.
 */
export function seedEncodeDepth(
  width: number,
  height: number,
  fps: number = REF_FPS,
): number {
  const mp = Math.max(1e-6, (width * height) / 1_000_000);
  const byPixels = TARGET_IN_FLIGHT_MP / mp;
  const ceiling = encodeDepthCeiling(fps);
  // Same resolution at 60fps → half the in-flight frames of 30fps.
  const byFpsScale = byPixels * (REF_FPS / Math.max(fps, REF_FPS));
  return clampEncodeDepth(Math.min(byPixels, byFpsScale, ceiling), ceiling);
}

export type AdaptEncodeDepthInput = {
  depth: number;
  emaCompositeMs: number;
  emaEncodeWaitMs: number;
  frameBudgetMs: number;
  /** Session max (fps ceiling); defaults to {@link ENCODE_DEPTH_MAX}. */
  maxDepth?: number;
};

/**
 * One-step depth adjustment. Pure — unit-testable without a real encoder.
 *
 * - Encode wait high → shrink (encoder-bound; deeper only burns memory).
 * - Composite heavy → shrink (producer-bound; deep pipe buys nothing).
 * - Composite light and encode wait ~0 → deepen (hide encode latency).
 */
export function adaptEncodeDepth(input: AdaptEncodeDepthInput): number {
  const {
    depth,
    emaCompositeMs,
    emaEncodeWaitMs,
    frameBudgetMs,
    maxDepth = ENCODE_DEPTH_MAX,
  } = input;
  const budget = Math.max(1e-3, frameBudgetMs);
  const max = Math.max(ENCODE_DEPTH_MIN, Math.min(ENCODE_DEPTH_MAX, maxDepth));

  if (emaEncodeWaitMs > budget * 0.75) {
    return Math.max(ENCODE_DEPTH_MIN, depth - 1);
  }
  if (emaCompositeMs > budget * 0.85) {
    return Math.max(ENCODE_DEPTH_MIN, depth - 1);
  }
  if (emaCompositeMs < budget * 0.4 && emaEncodeWaitMs < 1) {
    return Math.min(max, depth + 1);
  }
  return Math.min(max, depth);
}

function ema(prev: number, sample: number, framesBefore: number): number {
  if (framesBefore === 0) return sample;
  return EMA_ALPHA * sample + (1 - EMA_ALPHA) * prev;
}

/**
 * Bounded promise queue with adaptive depth. Call `push` after each
 * decode+composite; call `drain` before finalizing the container.
 */
export class AdaptiveEncodeQueue {
  depth: number;
  private readonly maxDepth: number;
  private readonly frameBudgetMs: number;
  private readonly pending: Promise<void>[] = [];
  private emaCompositeMs = 0;
  private emaEncodeWaitMs = 0;
  private frames = 0;
  private encodeWaits = 0;

  constructor(width: number, height: number, fps: number) {
    this.maxDepth = encodeDepthCeiling(fps);
    this.depth = seedEncodeDepth(width, height, fps);
    this.frameBudgetMs = 1000 / Math.max(1, fps);
  }

  /** Snapshot for logging / diagnostics. */
  stats(): {
    depth: number;
    maxDepth: number;
    pending: number;
    frames: number;
    emaCompositeMs: number;
    emaEncodeWaitMs: number;
    frameBudgetMs: number;
  } {
    return {
      depth: this.depth,
      maxDepth: this.maxDepth,
      pending: this.pending.length,
      frames: this.frames,
      emaCompositeMs: this.emaCompositeMs,
      emaEncodeWaitMs: this.emaEncodeWaitMs,
      frameBudgetMs: this.frameBudgetMs,
    };
  }

  /**
   * Enqueue one encode. Awaits the oldest pending add whenever the queue is
   * at depth — same backpressure shape as a fixed-depth pipeline.
   */
  async push(encode: Promise<void>, compositeMs: number): Promise<void> {
    this.emaCompositeMs = ema(this.emaCompositeMs, compositeMs, this.frames);
    this.pending.push(encode);
    this.frames += 1;

    while (this.pending.length >= this.depth) {
      const t0 = performance.now();
      await this.pending.shift()!;
      this.emaEncodeWaitMs = ema(
        this.emaEncodeWaitMs,
        performance.now() - t0,
        this.encodeWaits,
      );
      this.encodeWaits += 1;
    }

    if (this.frames % ADAPT_EVERY === 0) {
      this.depth = adaptEncodeDepth({
        depth: this.depth,
        emaCompositeMs: this.emaCompositeMs,
        emaEncodeWaitMs: this.emaEncodeWaitMs,
        frameBudgetMs: this.frameBudgetMs,
        maxDepth: this.maxDepth,
      });
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending);
    this.pending.length = 0;
  }
}

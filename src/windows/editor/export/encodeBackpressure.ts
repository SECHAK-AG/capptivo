/**
 * Adaptive encode-queue depth for the WebCodecs export loop.
 *
 * `CanvasSource.add()` captures the canvas synchronously, so the compositor can
 * redraw immediately while encodes finish asynchronously. Depth bounds how many
 * of those in-flight encodes we allow before awaiting the oldest — that is the
 * backpressure valve (memory + error latency).
 *
 * Seed depth from output megapixels (more pixels → fewer concurrent frames).
 * Then nudge ±1 every few frames from EMA of composite cost vs encode wait,
 * relative to the output frame budget (`1000/fps`).
 *
 * Ceiling matches a stable consumer-GPU encode queue (~48); the megapixel
 * soft-cap keeps 4K from opening that many full frames at once.
 * Backpressure awaits promises — never `requestAnimationFrame` (rAF stalls when
 * the window is backgrounded and can starve the encoder).
 */

export const ENCODE_DEPTH_MIN = 2;
export const ENCODE_DEPTH_MAX = 48;

/** Soft cap on in-flight uncompressed frame area (~48 MP total → ~23 at 1080p). */
const TARGET_IN_FLIGHT_MP = 48;

const EMA_ALPHA = 0.2;
/** How often depth may change — avoids thrashing every frame. */
const ADAPT_EVERY = 8;

export function clampEncodeDepth(n: number): number {
  return Math.max(ENCODE_DEPTH_MIN, Math.min(ENCODE_DEPTH_MAX, Math.round(n)));
}

/**
 * Initial queue depth from output resolution. 1080p (~2.1 MP) → ~23;
 * 4K (~8.3 MP) → ~6; small outputs hit the max.
 */
export function seedEncodeDepth(width: number, height: number): number {
  const mp = Math.max(1e-6, (width * height) / 1_000_000);
  return clampEncodeDepth(TARGET_IN_FLIGHT_MP / mp);
}

export type AdaptEncodeDepthInput = {
  depth: number;
  emaCompositeMs: number;
  emaEncodeWaitMs: number;
  frameBudgetMs: number;
};

/**
 * One-step depth adjustment. Pure — unit-testable without a real encoder.
 *
 * - Encode wait high → shrink (encoder-bound; deeper only burns memory).
 * - Composite heavy → shrink (producer-bound; deep pipe buys nothing).
 * - Composite light and encode wait ~0 → deepen (hide encode latency).
 */
export function adaptEncodeDepth(input: AdaptEncodeDepthInput): number {
  const { depth, emaCompositeMs, emaEncodeWaitMs, frameBudgetMs } = input;
  const budget = Math.max(1e-3, frameBudgetMs);

  if (emaEncodeWaitMs > budget * 0.75) {
    return Math.max(ENCODE_DEPTH_MIN, depth - 1);
  }
  if (emaCompositeMs > budget * 0.85) {
    return Math.max(ENCODE_DEPTH_MIN, depth - 1);
  }
  if (emaCompositeMs < budget * 0.4 && emaEncodeWaitMs < 1) {
    return Math.min(ENCODE_DEPTH_MAX, depth + 1);
  }
  return depth;
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
  private readonly frameBudgetMs: number;
  private readonly pending: Promise<void>[] = [];
  private emaCompositeMs = 0;
  private emaEncodeWaitMs = 0;
  private frames = 0;
  private encodeWaits = 0;

  constructor(width: number, height: number, fps: number) {
    this.depth = seedEncodeDepth(width, height);
    this.frameBudgetMs = 1000 / Math.max(1, fps);
  }

  /** Snapshot for logging / diagnostics. */
  stats(): {
    depth: number;
    pending: number;
    frames: number;
    emaCompositeMs: number;
    emaEncodeWaitMs: number;
    frameBudgetMs: number;
  } {
    return {
      depth: this.depth,
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
      });
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending);
    this.pending.length = 0;
  }
}

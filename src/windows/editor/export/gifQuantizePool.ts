/**
 * Fan GIF quantization across a small worker pool. Submission order ≠ completion
 * order, but callers must write frames in submission order — use
 * `OrderedPromiseQueue` for that (same backpressure shape as AdaptiveEncodeQueue).
 *
 * Returns `null` when workers are unavailable so the caller keeps the
 * main-thread path — same escape-hatch shape as `openSequentialMedia`.
 */

import type { GifQuantizeRequest, GifQuantizeResponse } from "./gifQuantize.worker";

export type QuantizedFrame = { palette: number[][]; index: Uint8Array };

export type GifQuantizePool = {
  /** Max in-flight frames (= worker count). Bound submit with OrderedPromiseQueue. */
  readonly depth: number;
  /** Submit a frame; resolves with its quantized result. Transfers the RGBA buffer. */
  submit: (rgba: Uint8ClampedArray) => Promise<QuantizedFrame>;
  dispose: () => void;
};

const POOL_MIN = 2;
const POOL_MAX = 4;

function poolSize(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  return Math.min(POOL_MAX, Math.max(POOL_MIN, cores));
}

/**
 * Ordered in-flight queue: await the oldest promise whenever depth is hit, so
 * results are consumed in submission order even when workers finish out of order.
 */
export class OrderedPromiseQueue<T> {
  private readonly pending: Promise<T>[] = [];
  readonly depth: number;

  constructor(depth: number) {
    this.depth = depth;
  }

  /** Enqueue; when at capacity, resolves with the oldest result (awaits it). */
  async push(next: Promise<T>): Promise<T | undefined> {
    this.pending.push(next);
    if (this.pending.length < this.depth) return undefined;
    return this.pending.shift()!;
  }

  /** Drain remaining entries in submission order. */
  async *drain(): AsyncGenerator<T> {
    while (this.pending.length > 0) {
      yield await this.pending.shift()!;
    }
  }

  get size(): number {
    return this.pending.length;
  }
}

export function createGifQuantizePool(
  width: number,
  height: number,
  colors: number,
  dither: boolean,
): GifQuantizePool | null {
  if (typeof Worker === "undefined") return null;

  let workers: Worker[];
  try {
    const size = poolSize();
    workers = Array.from({ length: size }, () =>
      new Worker(new URL("./gifQuantize.worker.ts", import.meta.url), {
        type: "module",
      }),
    );
  } catch (e) {
    console.warn("GIF quantize workers unavailable; using main thread", e);
    return null;
  }

  type Waiter = {
    resolve: (frame: QuantizedFrame) => void;
    reject: (err: unknown) => void;
  };
  const waiters = new Map<number, Waiter>();
  const free: Worker[] = [...workers];
  const waitingForWorker: Array<{
    resolve: (worker: Worker) => void;
    reject: (error: unknown) => void;
  }> = [];
  let nextId = 1;
  let disposed = false;
  let failed: unknown = null;

  for (const worker of workers) {
    worker.onmessage = (event: MessageEvent<GifQuantizeResponse>) => {
      const { id, palette, index } = event.data;
      const waiter = waiters.get(id);
      waiters.delete(id);
      free.push(worker);
      const next = waitingForWorker.shift();
      if (next) next.resolve(free.pop()!);
      waiter?.resolve({ palette, index: new Uint8Array(index) });
    };
    worker.onerror = (err) => {
      if (failed || disposed) return;
      failed = err;
      // Reject every in-flight and queued waiter — a dead worker cannot be
      // returned to the free list, and leaving a queued promise pending would
      // park the export forever.
      for (const [id, waiter] of waiters) {
        waiters.delete(id);
        waiter.reject(err);
      }
      for (const pending of waitingForWorker.splice(0)) pending.reject(err);
      for (const other of workers) other.terminate();
      free.length = 0;
    };
  }

  const acquire = (): Promise<Worker> => {
    if (disposed) return Promise.reject(new Error("GIF quantize pool disposed"));
    if (failed) return Promise.reject(failed);
    const w = free.pop();
    if (w) return Promise.resolve(w);
    return new Promise((resolve, reject) => waitingForWorker.push({ resolve, reject }));
  };

  return {
    depth: workers.length,
    submit(rgba: Uint8ClampedArray): Promise<QuantizedFrame> {
      if (disposed) return Promise.reject(new Error("GIF quantize pool disposed"));
      if (failed) return Promise.reject(failed);
      const id = nextId++;
      // Transfer the underlying buffer (getImageData allocates fresh per frame).
      const buffer =
        rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength
          ? (rgba.buffer as ArrayBuffer)
          : rgba.slice().buffer;

      return acquire().then((worker) => {
        const result = new Promise<QuantizedFrame>((resolve, reject) => {
          waiters.set(id, { resolve, reject });
        });
        const msg: GifQuantizeRequest = {
          id,
          width,
          height,
          colors,
          dither,
          rgba: buffer,
        };
        worker.postMessage(msg, [buffer]);
        return result;
      });
    },
    dispose() {
      disposed = true;
      const error = new Error("GIF quantize pool disposed");
      for (const w of workers) w.terminate();
      workers = [];
      free.length = 0;
      for (const pending of waitingForWorker.splice(0)) pending.reject(error);
      for (const waiter of waiters.values()) waiter.reject(error);
      waiters.clear();
    },
  };
}

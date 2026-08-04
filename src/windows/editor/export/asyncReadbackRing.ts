/**
 * Bookkeeping for in-flight asynchronous GPU readbacks.
 *
 * `gl.readPixels` into a `Uint8Array` blocks until the GPU has drained every
 * queued command and the transfer has completed, so the export loop alternates:
 * the GPU composites while the CPU idles, then the CPU waits while the GPU
 * copies. Reading into a `PIXEL_PACK_BUFFER` instead returns immediately, and a
 * fence says when the pixels are actually there — so frame N's transfer overlaps
 * frame N+1's compositing.
 *
 * What has to be tracked is which pooled buffer belongs to which fence, in
 * order. Frames must reach FFmpeg in the order they were composed, so this is a
 * FIFO, never a free-for-all: the oldest readback is always the next one
 * collected.
 *
 * Pure on purpose — selfchecks run under plain Node without Vite aliases.
 */

/**
 * Readbacks allowed in flight at once, and therefore how many frames of
 * latency the transfer is given to complete before the loop waits on it.
 *
 * Three is the useful minimum: begin N, collect N-2, and one slot spare so the
 * ring is never momentarily empty between the two. Deeper buys nothing — the
 * transfer takes well under two frame times — and each slot pins a
 * `width * height * 4` GPU buffer.
 */
export const ASYNC_READBACK_RING_SIZE = 3;

/**
 * Pooled CPU buffers needed to keep that ring fed.
 *
 * A buffer is held from `acquire()` until its IPC write settles — which spans
 * *both* the readback and the write. Sizing the pool to the ring alone would
 * deadlock: every buffer would sit in a fence while the writer had none to send.
 * The two extra slots cover the writes in flight.
 */
export const FRAME_POOL_SIZE = ASYNC_READBACK_RING_SIZE + 2;

export type InFlightReadback = {
  /** Ticket from `beginReadPixels`, resolved via `tryFinishReadPixels`. */
  ticket: number;
  /** The pooled buffer this readback will be copied into. */
  buffer: Uint8Array;
};

/** FIFO of readbacks awaiting their fence, oldest first. */
export class InFlightReadbacks {
  // Written out rather than declared as constructor parameter properties: the
  // selfchecks run under Node's strip-only TypeScript mode, which rejects those.
  readonly capacity: number;
  private readonly queue: InFlightReadback[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer (got ${capacity})`);
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.queue.length;
  }

  /** True when no further readback may begin until one is collected. */
  get isFull(): boolean {
    return this.queue.length >= this.capacity;
  }

  push(item: InFlightReadback): void {
    if (this.isFull) {
      // The caller is expected to collect before beginning another readback;
      // overflowing would silently reorder frames in the output file.
      throw new RangeError("in-flight readback ring overflow");
    }
    this.queue.push(item);
  }

  /** The oldest readback, or `null` when nothing is in flight. */
  peek(): InFlightReadback | null {
    return this.queue[0] ?? null;
  }

  /** Remove and return the oldest readback. */
  shift(): InFlightReadback | null {
    return this.queue.shift() ?? null;
  }
}

/**
 * Fixed-size frame buffers for the export loop, recycled instead of reallocated.
 *
 * A 1080p RGBA frame is 8.29 MB. Allocating one per frame — which is what
 * `getImageData` plus a defensive `new Uint8Array(...)` amounted to — produced
 * hundreds of megabytes of short-lived garbage per export and handed the GC a
 * reason to pause the encode loop. The pool bounds that to `count` buffers
 * allocated once, up front.
 *
 * The pool doubles as the backpressure signal: `acquire()` returning `null`
 * means every buffer is still in flight to FFmpeg, which is exactly when the
 * loop should stop composing. Callers must never allocate a replacement buffer
 * when that happens — that would reintroduce the garbage *and* remove the
 * pressure that keeps memory bounded.
 *
 * Pure on purpose — selfchecks run under plain Node without Vite aliases.
 */

export class FramePool {
  // Written out rather than declared as constructor parameter properties: the
  // selfchecks run under Node's strip-only TypeScript mode, which rejects those.
  readonly frameBytes: number;
  private readonly owned: Set<Uint8Array>;
  private readonly free: Uint8Array[];

  constructor(frameBytes: number, count: number) {
    if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
      throw new RangeError(`frameBytes must be a positive integer (got ${frameBytes})`);
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(`count must be a positive integer (got ${count})`);
    }
    this.frameBytes = frameBytes;
    this.free = Array.from({ length: count }, () => new Uint8Array(frameBytes));
    this.owned = new Set(this.free);
  }

  /** A free buffer, or `null` when all of them are in flight. */
  acquire(): Uint8Array | null {
    return this.free.pop() ?? null;
  }

  /**
   * Return a buffer for reuse.
   *
   * Ignores buffers this pool never handed out, and ignores a second release of
   * a buffer already returned. Either would otherwise let two writers hold the
   * same memory at once, which corrupts one frame in a way that is very hard to
   * trace back to here.
   */
  release(buffer: Uint8Array): void {
    if (!this.owned.has(buffer)) return;
    if (this.free.includes(buffer)) return;
    this.free.push(buffer);
  }

  /** Buffers currently available — diagnostics and tests. */
  get available(): number {
    return this.free.length;
  }
}

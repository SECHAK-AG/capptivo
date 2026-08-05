/**
 * Deadlines for the export pipeline.
 *
 * Every wait in an export loop must be able to give up. WebView2's WebCodecs
 * H.264 encoder can accept `configure()` and then accept frames forever without
 * ever emitting a chunk — no error, no rejected promise, just silence. The
 * backpressure loops spin on `encodeQueueSize`, which never drops, so the export
 * freezes at whatever percentage the queue depth already allowed: ~23 frames of
 * a 1080p30 export, which is the "stuck at 1%" report this module exists to
 * convert into a route switch.
 *
 * A stall is therefore *not* a fatal error. It means "this route is dead on this
 * machine" and the caller is expected to try the next one.
 *
 * Pure on purpose — selfchecks run under plain Node without Vite aliases.
 */

/** No progress for this long inside a frame loop → the route is dead. */
export const ENCODE_STALL_MS = 8_000;

/** `flush()`/finalize gets longer: it legitimately drains a full queue. */
export const FLUSH_STALL_MS = 30_000;

/**
 * Async PBO fence that stays pending this long → force-finish that frame and
 * latch to sync `readPixels` for the rest of the export. Shorter than
 * {@link ENCODE_STALL_MS} so WebView2 fence hangs degrade to sync instead of
 * aborting the only Windows MP4 route.
 */
export const ASYNC_READBACK_FALLBACK_MS = 2_000;

export class ExportStallError extends Error {
  readonly name = "ExportStallError";
  constructor(where: string, stalledMs: number) {
    super(`export stalled: no progress in ${where} for ${Math.round(stalledMs)}ms`);
  }
}

export function isExportStallError(e: unknown): boolean {
  return e instanceof ExportStallError;
}

/**
 * Watches a monotonically increasing progress token.
 *
 * The token is whatever counts as real forward motion for the loop being
 * watched — chunks emitted plus writes completed, say. One increasing number is
 * enough, and it is far easier to reason about than tracking several counters
 * that each move in their own direction: if the number goes up, work happened.
 */
export class StallWatchdog {
  // Written out rather than declared as constructor parameter properties: the
  // selfchecks run under Node's strip-only TypeScript mode, which rejects those.
  private readonly where: string;
  private readonly stallMs: number;
  private lastToken = Number.NEGATIVE_INFINITY;
  private lastProgressAt: number;

  constructor(
    where: string,
    stallMs: number = ENCODE_STALL_MS,
    now: number = performance.now(),
  ) {
    this.where = where;
    this.stallMs = stallMs;
    this.lastProgressAt = now;
  }

  /** Throws {@link ExportStallError} once the token has been flat for `stallMs`. */
  check(token: number, now: number = performance.now()): void {
    if (token > this.lastToken) {
      this.lastToken = token;
      this.lastProgressAt = now;
      return;
    }
    const stalledFor = now - this.lastProgressAt;
    if (stalledFor >= this.stallMs) {
      throw new ExportStallError(this.where, stalledFor);
    }
  }
}

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * The underlying operation is not cancelled — it cannot be, for a WebCodecs
 * flush that has wedged. Callers close the encoder afterwards, which is what
 * actually releases it.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  where: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExportStallError(where, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

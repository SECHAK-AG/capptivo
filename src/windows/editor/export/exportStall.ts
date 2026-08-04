/**
 * Encode / IPC backpressure stall detection.
 * Pure — WebView2 HW (and sometimes SW) encode can freeze without erroring.
 */

/** No queue/write progress for this long → fail the Annex-B path. */
export const ENCODE_STALL_MS = 8_000;

export type StallWaitState = {
  /** Wall time when the current no-progress window started. */
  waitStartedAt: number;
  lastEncodeQueue: number;
  lastPendingWrites: number;
};

export function createStallWaitState(
  now: number,
  encodeQueue: number,
  pendingWrites: number,
): StallWaitState {
  return {
    waitStartedAt: now,
    lastEncodeQueue: encodeQueue,
    lastPendingWrites: pendingWrites,
  };
}

/**
 * Update stall tracking for one backpressure spin.
 * Returns `stalled: true` when there has been no progress for `stallMs`.
 */
export function tickEncodeStall(
  state: StallWaitState,
  now: number,
  encodeQueue: number,
  pendingWrites: number,
  stallMs: number = ENCODE_STALL_MS,
): { stalled: boolean; state: StallWaitState } {
  const progressed =
    encodeQueue < state.lastEncodeQueue ||
    pendingWrites < state.lastPendingWrites;

  if (progressed) {
    return {
      stalled: false,
      state: {
        waitStartedAt: now,
        lastEncodeQueue: encodeQueue,
        lastPendingWrites: pendingWrites,
      },
    };
  }

  return {
    stalled: now - state.waitStartedAt >= stallMs,
    state: {
      ...state,
      lastEncodeQueue: encodeQueue,
      lastPendingWrites: pendingWrites,
    },
  };
}

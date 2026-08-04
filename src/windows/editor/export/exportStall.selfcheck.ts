/** Selfcheck: encode stall detection (pure). */

import {
  ENCODE_STALL_MS,
  createStallWaitState,
  tickEncodeStall,
} from "./exportStall.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const t0 = 1_000;
let state = createStallWaitState(t0, 12, 0);

// No progress under budget → not stalled.
{
  const r = tickEncodeStall(state, t0 + 100, 12, 0, ENCODE_STALL_MS);
  assert(!r.stalled, "short wait must not stall");
  state = r.state;
}

// Still no progress past budget → stalled.
{
  const r = tickEncodeStall(state, t0 + ENCODE_STALL_MS + 1, 12, 0, ENCODE_STALL_MS);
  assert(r.stalled, "no progress past stallMs must stall");
}

// Queue drain resets the window.
{
  state = createStallWaitState(t0, 12, 4);
  const mid = tickEncodeStall(state, t0 + 4_000, 8, 4, ENCODE_STALL_MS);
  assert(!mid.stalled, "queue drain is progress");
  const later = tickEncodeStall(
    mid.state,
    mid.state.waitStartedAt + ENCODE_STALL_MS - 1,
    8,
    4,
    ENCODE_STALL_MS,
  );
  assert(!later.stalled, "progress resets the stall clock");
}

console.log("exportStall.selfcheck: ok");

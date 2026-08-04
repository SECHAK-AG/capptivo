/** Selfcheck: in-flight async readback bookkeeping (pure). */

import {
  ASYNC_READBACK_RING_SIZE,
  FRAME_POOL_SIZE,
  InFlightReadbacks,
} from "./asyncReadbackRing.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const buf = (n: number) => new Uint8Array([n]);

// The pool must outnumber the ring, or every buffer sits in a fence and the
// writer starves — a deadlock, not a slowdown.
assert(
  FRAME_POOL_SIZE > ASYNC_READBACK_RING_SIZE,
  "the frame pool must be deeper than the readback ring",
);
assert(ASYNC_READBACK_RING_SIZE >= 2, "pipelining needs at least two slots");

// FIFO order is the whole contract: frames must reach ffmpeg as composed.
{
  const ring = new InFlightReadbacks(3);
  assert(ring.size === 0 && !ring.isFull, "a fresh ring is empty");
  assert(ring.peek() === null, "peek on an empty ring is null");
  assert(ring.shift() === null, "shift on an empty ring is null");

  ring.push({ ticket: 1, buffer: buf(1) });
  ring.push({ ticket: 2, buffer: buf(2) });
  ring.push({ ticket: 3, buffer: buf(3) });
  assert(ring.isFull, "three pushes fill a ring of three");
  assert(ring.peek()?.ticket === 1, "peek returns the oldest");

  assert(ring.shift()?.ticket === 1, "first out is first in");
  assert(ring.shift()?.ticket === 2, "second out is second in");
  assert(!ring.isFull, "shifting frees capacity");
  assert(ring.shift()?.ticket === 3, "third out is third in");
  assert(ring.size === 0, "ring drains to empty");
}

// Overflow must throw rather than silently reorder the output video.
{
  const ring = new InFlightReadbacks(2);
  ring.push({ ticket: 1, buffer: buf(1) });
  ring.push({ ticket: 2, buffer: buf(2) });
  let threw = false;
  try {
    ring.push({ ticket: 3, buffer: buf(3) });
  } catch {
    threw = true;
  }
  assert(threw, "pushing past capacity must throw, never drop or reorder");
}

// A buffer travels with its ticket — mixing them up would write one frame's
// pixels into another frame's slot.
{
  const ring = new InFlightReadbacks(2);
  const a = buf(10);
  const b = buf(20);
  ring.push({ ticket: 7, buffer: a });
  ring.push({ ticket: 8, buffer: b });
  const first = ring.shift();
  assert(first?.ticket === 7 && first.buffer === a, "ticket 7 keeps buffer a");
  const second = ring.shift();
  assert(second?.ticket === 8 && second.buffer === b, "ticket 8 keeps buffer b");
}

// Construction rejects nonsense rather than failing mid-export.
for (const bad of [0, -1, 1.5]) {
  let threw = false;
  try {
    new InFlightReadbacks(bad);
  } catch {
    threw = true;
  }
  assert(threw, `InFlightReadbacks(${bad}) must be rejected`);
}

console.log("asyncReadbackRing.selfcheck: ok");

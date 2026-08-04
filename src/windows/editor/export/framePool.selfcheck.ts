/** Selfcheck: export frame buffer pool (pure). */

import { FramePool } from "./framePool.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Buffers are the requested size and there are exactly `count` of them.
{
  const pool = new FramePool(64, 3);
  assert(pool.available === 3, "a fresh pool offers every buffer");
  const taken = [pool.acquire(), pool.acquire(), pool.acquire()];
  for (const buf of taken) {
    assert(buf !== null, "the first `count` acquires must succeed");
    assert(buf!.length === 64, "buffers are exactly frameBytes long");
  }
  assert(pool.available === 0, "an exhausted pool offers nothing");
  assert(
    pool.acquire() === null,
    "exhaustion returns null — that is the backpressure signal",
  );
}

// A released buffer is handed out again rather than a new one being allocated.
{
  const pool = new FramePool(8, 1);
  const first = pool.acquire();
  assert(first !== null, "first acquire succeeds");
  assert(pool.acquire() === null, "pool of 1 is now empty");
  pool.release(first!);
  assert(pool.available === 1, "release returns the buffer to the pool");
  assert(
    pool.acquire() === first,
    "the same backing buffer is reused, not reallocated",
  );
}

// Releasing a buffer the pool never owned must not grow it — otherwise two
// writers could end up holding the same memory.
{
  const pool = new FramePool(8, 1);
  pool.release(new Uint8Array(8));
  assert(pool.available === 1, "a foreign buffer is ignored");
  const own = pool.acquire();
  assert(own !== null, "the pool still holds only its own buffer");
  assert(pool.acquire() === null, "a foreign release did not inflate the pool");
}

// Double release is ignored for the same reason.
{
  const pool = new FramePool(8, 2);
  const buf = pool.acquire();
  assert(buf !== null, "acquire succeeds");
  pool.release(buf!);
  pool.release(buf!);
  assert(pool.available === 2, "a repeated release does not duplicate a buffer");
  const a = pool.acquire();
  const b = pool.acquire();
  assert(a !== b, "no two live buffers are ever the same object");
}

// Construction rejects nonsense rather than failing later inside the loop.
for (const [bytes, count] of [
  [0, 1],
  [-1, 1],
  [1.5, 1],
  [8, 0],
  [8, -2],
] as const) {
  let threw = false;
  try {
    new FramePool(bytes, count);
  } catch {
    threw = true;
  }
  assert(threw, `FramePool(${bytes}, ${count}) must be rejected`);
}

console.log("framePool.selfcheck: ok");

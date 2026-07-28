/** Selfcheck: GIF quantize ordered-drain queue. */

import { OrderedPromiseQueue } from "./gifQuantizePool.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  // Resolve out of order (3, then 1, then 2) but emit in submission order.
  const resolvers: Array<(n: number) => void> = [];
  const make = (id: number) =>
    new Promise<number>((resolve) => {
      resolvers[id] = resolve;
    });

  const q = new OrderedPromiseQueue<number>(2);
  const emitted: number[] = [];

  const collect = async (v: number | undefined) => {
    if (v !== undefined) emitted.push(v);
  };

  // Push 1 — under depth, no emit.
  const p1 = q.push(make(0));
  assert(q.size === 1, "one in flight after first push");
  // Push 2 — at depth, awaits oldest (promise 0).
  const p2 = q.push(make(1));
  assert(q.size === 1, "awaiting oldest leaves one pending (the second)");

  // Finish 2 first — must not emit yet (still blocked on 1).
  resolvers[1]!(2);
  await Promise.resolve();
  assert(emitted.length === 0, "must not emit out of order");

  // Finish 1 — p2's await of oldest resolves with 1.
  resolvers[0]!(1);
  await collect(await p1); // undefined (was under depth when pushed)
  await collect(await p2); // 1
  assert(emitted.join(",") === "1", `expected emit 1, got ${emitted}`);

  // Push 3 — under depth again (size was 0 after shift).
  const p3 = q.push(make(2));
  resolvers[2]!(3);
  await collect(await p3);

  // Drain remaining (the second promise, value 2, still in queue).
  for await (const v of q.drain()) emitted.push(v);
  assert(emitted.join(",") === "1,2,3", `expected 1,2,3 got ${emitted}`);

  // Empty drain is a no-op.
  const extra: number[] = [];
  for await (const v of q.drain()) extra.push(v);
  assert(extra.length === 0, "empty drain must be a no-op");

  // Depth bound: never hold more than `depth` in-flight entries.
  const q2 = new OrderedPromiseQueue<number>(3);
  const hold: Array<(n: number) => void> = [];
  const held = (id: number) =>
    new Promise<number>((resolve) => {
      hold[id] = resolve;
    });
  void q2.push(held(0));
  void q2.push(held(1));
  assert(q2.size === 2, "two pending under depth");
  const blocked = q2.push(held(2)); // at depth → awaits oldest
  assert(q2.size === 2, "at depth: oldest removed from queue while awaited");
  hold[0]!(10);
  assert((await blocked) === 10, "at-depth push returns oldest result");
  assert(q2.size === 2, "two remain after oldest resolved");

  console.log("gifQuantizePool.selfcheck: ok");
}

void main();

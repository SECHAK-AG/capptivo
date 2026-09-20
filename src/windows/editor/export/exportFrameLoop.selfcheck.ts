/**
 * Runnable check for pipelined export frame iteration. Run:
 *   node --experimental-strip-types src/windows/editor/export/exportFrameLoop.selfcheck.ts
 */

import { createExportFrameIterator } from "./exportFrameLoop.ts";

export {};

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function check(actual: number, expected: number, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg} (got ${actual}, want ${expected})`);
  }
}

const times = [0, 1, 2];
let cursor = 0;
const reader = {
  nextFrame: async () => {
    cursor += 1;
  },
};

const iter = createExportFrameIterator(times, reader, null);
assert(iter.mode === "sequential", "reader → sequential");
assert(iter.count === 3, "frame count");
assert(iter.timeAt(1) === 1, "timeAt");

await iter.prime();
check(cursor, 1, "prime decodes frame 0");

await iter.advance(0);
check(cursor, 2, "advance(0) pipelines decode for frame 1");

await iter.advance(1);
check(cursor, 3, "advance(1) awaits frame 1 and pipelines frame 2");

await iter.advance(2);
check(cursor, 3, "advance(2) awaits frame 2");

iter.dispose();

class FakeVideo {
  private value = -1;
  readonly seeks: number[] = [];
  duration = 3;
  private readonly listeners = new Map<string, Set<() => void>>();

  get currentTime(): number {
    return this.value;
  }

  set currentTime(next: number) {
    this.value = next;
    this.seeks.push(next);
    queueMicrotask(() => this.emit("seeked"));
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const seekVideo = new FakeVideo();
const seekIter = createExportFrameIterator(times, null, {
  video: seekVideo as unknown as HTMLVideoElement,
  camera: null,
  faceCam: { url: null, offsetMs: null },
});
await seekIter.prime();
await seekIter.advance(0);
await seekIter.advance(1);
await seekIter.advance(2);
check(seekVideo.seeks.length, 3, "seek path has one seek per frame");
check(seekVideo.seeks[0]!, 0, "seek frame 0");
check(seekVideo.seeks[1]!, 1, "seek frame 1");
check(seekVideo.seeks[2]!, 2, "seek frame 2");
seekIter.dispose();

console.log("exportFrameLoop.selfcheck: ok");

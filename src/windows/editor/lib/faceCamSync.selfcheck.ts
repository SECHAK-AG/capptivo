/** Selfcheck: faceCamSync clamp semantics. */

import { faceCamFrameAt, faceCamMediaTime } from "./faceCamSync.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const dur = 10;

assert(faceCamFrameAt(0, 0, dur).state === "active", "aligned start is active");
assert(
  faceCamFrameAt(0.5, 1000, dur).state === "active",
  "before offset clamps to first frame",
);
{
  const f = faceCamFrameAt(0.5, 1000, dur);
  assert(f.state === "active" && f.mediaTime > 0, "clamped mediaTime > 0");
}
assert(faceCamFrameAt(1.5, 1000, dur).state === "active", "past offset → active");
{
  const f = faceCamFrameAt(1.5, 1000, dur);
  assert(
    f.state === "active" && Math.abs(f.mediaTime - 0.5) < 1e-9,
    "mediaTime = t − offset",
  );
}
assert(faceCamFrameAt(20, 0, dur).state === "hold", "past EOF holds");
assert(faceCamMediaTime(0.5, 1000, dur) !== null, "clamped frame is exportable");
assert(faceCamMediaTime(0, null, dur) !== null, "null offset treated as aligned");

console.log("faceCamSync.selfcheck: ok");

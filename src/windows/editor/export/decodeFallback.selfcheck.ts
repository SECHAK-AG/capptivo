/** Selfcheck: decode-fallback reason strings (pure). */

import {
  DETAIL_CAP,
  decodeFallbackMessage,
  decodeFallbackReason,
  trimDetail,
} from "./decodeFallback.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Each code must produce a distinct, non-empty reason — the whole point is
// telling four different failures apart in a log after the fact.
const reasons = [
  decodeFallbackReason("no-decoder"),
  decodeFallbackReason("no-video-track"),
  decodeFallbackReason("undecodable"),
  decodeFallbackReason("open-failed", "boom"),
];
assert(
  reasons.every((r) => r.length > 0),
  "every code must yield a reason",
);
assert(new Set(reasons).size === reasons.length, "reasons must be distinguishable");

assert(
  decodeFallbackReason("open-failed", "boom").includes("boom"),
  "a thrown detail must reach the log",
);
assert(
  decodeFallbackReason("open-failed", "").includes("no detail"),
  "an empty detail must still say something",
);

// This lands in a rolling file on a user's disk; one export can append several.
{
  const long = "x".repeat(DETAIL_CAP * 5);
  const trimmed = trimDetail(long);
  assert(trimmed.length <= DETAIL_CAP + 1, `detail must stay bounded (got ${trimmed.length})`);
}

// Multi-line demuxer errors must not break the one-line-per-entry log format.
{
  const trimmed = trimDetail("first line\n\n  second line \r\nthird");
  assert(!trimmed.includes("\n"), "must collapse to one line");
  assert(!trimmed.includes("\r"), "must collapse carriage returns too");
  assert(trimmed === "first line; second line; third", `unexpected: ${trimmed}`);
}

// Truncation counts chars, so a run of multi-byte characters comes back whole.
{
  const trimmed = trimDetail("日".repeat(DETAIL_CAP * 2));
  assert(!trimmed.includes("�"), "must not split a character");
}

// The message must carry the consequence, not just the cause — a reader asking
// "why is this export slow" is not served by the reason alone.
{
  const msg = decodeFallbackMessage("rawvideo", decodeFallbackReason("no-decoder"));
  assert(msg.includes("rawvideo"), "message names the route that fell back");
  assert(msg.includes("VideoDecoder"), "message carries the reason");
  assert(msg.includes("slower"), "message states the consequence");
}

console.log("decodeFallback.selfcheck: ok");

import {
  MIN_KEPT_AFTER_SILENCE_CUTS_SEC,
  SILENCE_CUT_PAD_SEC,
  buildSilenceCutSuggestions,
} from "./silenceCutUtils.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const duration = 60;

assert(
  buildSilenceCutSuggestions({ silences: [], duration: 0 }).status ===
    "no-duration",
  "zero duration",
);

assert(
  buildSilenceCutSuggestions({ silences: [], duration }).status ===
    "no-silence",
  "no silence intervals",
);

assert(
  buildSilenceCutSuggestions({
    silences: [{ startMs: 1_000, endMs: 1_400 }],
    duration,
  }).status === "no-silence",
  "silence shorter than the minimum is ignored",
);

const padded = buildSilenceCutSuggestions({
  silences: [{ startMs: 10_000, endMs: 14_000 }],
  duration,
});
assert(padded.status === "ok" && padded.cuts.length === 1, "one cut");
assert(
  padded.cuts[0].start === 10 + SILENCE_CUT_PAD_SEC &&
    padded.cuts[0].end === 14 - SILENCE_CUT_PAD_SEC,
  "cut is padded inward so speech is never clipped",
);

const trailing = buildSilenceCutSuggestions({
  silences: [{ startMs: 50_000, endMs: Number.MAX_SAFE_INTEGER }],
  duration,
});
assert(
  trailing.status === "ok" && trailing.cuts[0].end <= duration,
  "open-ended trailing silence is clamped to duration",
);

const reserved = buildSilenceCutSuggestions({
  silences: [{ startMs: 10_000, endMs: 14_000 }],
  duration,
  reservedSpans: [{ start: 9, end: 15 }],
});
assert(
  reserved.status === "no-slots",
  "a range already trimmed is not cut again",
);

const wholeVideo = buildSilenceCutSuggestions({
  silences: [{ startMs: 0, endMs: duration * 1000 }],
  duration,
});
assert(
  wholeVideo.cuts.every(
    (c) => duration - (c.end - c.start) >= MIN_KEPT_AFTER_SILENCE_CUTS_SEC,
  ),
  "never cuts away the whole recording",
);

console.log("silenceCutUtils.selfcheck: ok");

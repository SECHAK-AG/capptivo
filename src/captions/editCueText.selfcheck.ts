/** Selfcheck: caption text edits keep or drop word timings correctly. */
import {
  normalizeCaptionEdit,
  updateCaptionListText,
  withUpdatedCaptionText,
} from "./editCueText.ts";
import type { CaptionCue } from "./types.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const base: CaptionCue = {
  id: "1",
  startMs: 0,
  endMs: 1000,
  text: "Hello Captivo world",
  words: [
    { text: "Hello", startMs: 0, endMs: 200, leadingSpace: false },
    { text: "Captivo", startMs: 200, endMs: 600, leadingSpace: true },
    { text: "world", startMs: 600, endMs: 1000, leadingSpace: true },
  ],
};

const fixed = withUpdatedCaptionText(base, "  Hello Capptivo world  ");
assert(fixed.text === "Hello Capptivo world", "normalized text");
assert(fixed.words?.length === 3, "kept word timings");
assert(fixed.words?.[1]?.text === "Capptivo", "rewrote misspelled token");
assert(fixed.words?.[1]?.startMs === 200, "kept token timing");

const shorter = withUpdatedCaptionText(base, "Hello Capptivo");
assert(shorter.text === "Hello Capptivo", "shorter text");
assert(shorter.words === undefined, "dropped words when token count changes");

assert(withUpdatedCaptionText(base, "") === base, "empty edit is no-op");
assert(
  withUpdatedCaptionText(base, "Hello Captivo world") === base,
  "identical text is no-op",
);

const list = updateCaptionListText([base], "1", "Hello Capptivo world");
assert(list[0]!.text.includes("Capptivo"), "list update");
const missing = [base];
assert(updateCaptionListText(missing, "nope", "x") === missing, "missing id keeps ref");
const sameRef = [base];
assert(
  updateCaptionListText(sameRef, "1", "Hello Captivo world") === sameRef,
  "identical edit keeps ref",
);

assert(normalizeCaptionEdit("  a   b  ") === "a b", "normalize spaces");

console.log("editCueText.selfcheck: ok");

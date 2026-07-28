/**
 * Runnable check for the caption layer's content key. Run:
 *   node_modules/.bin/jiti src/captions/captionFrameKey.selfcheck.ts
 *
 * (jiti rather than `--experimental-strip-types`, because this module's imports
 * are extensionless and only a bundler-style resolver follows them.)
 *
 * The GPU compositor repaints and re-uploads the caption texture only when this
 * key changes, so it has to be stable *within* a highlighted word and change on
 * every input that alters the drawn pixels. Too sticky and captions freeze; too
 * loose and we are back to an 8 MB upload every frame.
 */
import { captionFrameKey } from "./drawCaptions.ts";
import { DEFAULT_CAPTION_SETTINGS } from "./settings.ts";
import type { CaptionCue } from "./types.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const settings = { ...DEFAULT_CAPTION_SETTINGS, enabled: true };
const cues: CaptionCue[] = [
  {
    id: "a",
    startMs: 0,
    endMs: 2000,
    text: "hello brave world",
    words: [
      { text: "hello", startMs: 0, endMs: 500 },
      { text: "brave", startMs: 500, endMs: 1200, leadingSpace: true },
      { text: "world", startMs: 1200, endMs: 2000, leadingSpace: true },
    ],
  },
  { id: "b", startMs: 2000, endMs: 4000, text: "second cue" },
];

const key = (timeMs: number, s = settings, w = 1920, h = 1080) =>
  captionFrameKey(cues, s, w, h, timeMs);

assert(key(100) !== null, "an active cue produces a key");
assert(key(100) === key(300), "same word → same key (no repaint mid-word)");
assert(key(100) !== key(700), "next word → new key (karaoke must repaint)");
assert(key(700) !== key(1500), "third word → new key");
assert(key(100) !== key(2500), "different cue → new key");

assert(key(100) !== key(100, settings, 1280, 720), "stage size is part of the key");
assert(
  key(100) !== key(100, { ...settings, fontSizePx: 52 }),
  "settings changes must invalidate the key",
);
assert(
  key(100) !== key(100, { ...settings, textColor: "#ff0000" }),
  "colour changes must invalidate the key",
);

assert(key(100, { ...settings, enabled: false }) === null, "disabled → nothing to draw");
assert(captionFrameKey([], settings, 1920, 1080, 100) === null, "no cues → nothing to draw");
assert(key(9000) === null || key(9000) !== key(100), "past the last cue must not reuse a key");

console.log("captionFrameKey.selfcheck: ok");

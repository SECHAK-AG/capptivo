/**
 * Apply a user edit to one caption cue.
 *
 * When the whitespace token count still matches Whisper word timings, keep
 * karaoke by rewriting token text in place. Otherwise drop `words` so draw
 * falls back to `cue.text` (correct spelling, no word-follow on that cue).
 */

import type { CaptionCue } from "./types";

/** Normalize for compare/persist — trim ends, collapse internal runs of space. */
export function normalizeCaptionEdit(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function withUpdatedCaptionText(
  cue: CaptionCue,
  nextText: string,
): CaptionCue {
  const text = normalizeCaptionEdit(nextText);
  if (!text || text === normalizeCaptionEdit(cue.text)) return cue;

  const tokens = text.split(" ");
  const words = cue.words;
  // Same token count → keep timings (karaoke). Draw already ignores bad timings.
  if (words && words.length === tokens.length) {
    return {
      ...cue,
      text,
      words: words.map((w, i) => ({
        ...w,
        text: tokens[i]!,
      })),
    };
  }

  const { words: _drop, ...rest } = cue;
  return { ...rest, text };
}

/** Replace one cue by id; returns the same array reference when nothing changes. */
export function updateCaptionListText(
  captions: CaptionCue[],
  cueId: string,
  nextText: string,
): CaptionCue[] {
  const i = captions.findIndex((c) => c.id === cueId);
  if (i < 0) return captions;
  const next = withUpdatedCaptionText(captions[i]!, nextText);
  if (next === captions[i]) return captions;
  const out = captions.slice();
  out[i] = next;
  return out;
}

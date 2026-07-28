/** Caption clock + karaoke word pick (Whisper token times only). */

import type { CaptionCue, CaptionCueWord } from "./types";

const CUE_POST_ROLL_SEC = 0.22;
const CUE_NEXT_LEAD_IN_SEC = 0.04;
const WORD_SYNC_EPS_SEC = 0.018;
const WORD_PARTITION_MIN_SEC = 0.02;

export type TimedDrawWord = {
  text: string;
  startSec: number;
  endSec: number;
  leadingSpace: boolean;
};

function isValidWordTiming(w: CaptionCueWord): boolean {
  return (
    typeof w.text === "string" &&
    w.text.trim().length > 0 &&
    Number.isFinite(w.startMs) &&
    Number.isFinite(w.endMs) &&
    w.endMs > w.startMs
  );
}

/** True when every token in the cue has usable Whisper timings. */
export function cueHasWordTimings(cue: CaptionCue): boolean {
  const words = cue.words;
  if (!words?.length) return false;
  return words.every(isValidWordTiming);
}

export function captionsHaveWordTimings(cues: CaptionCue[]): boolean {
  return cues.length > 0 && cues.some(cueHasWordTimings);
}

export function playbackTimeMs(sourceTimeMs: number, timingOffsetMs: number): number {
  return sourceTimeMs + timingOffsetMs;
}

function msToSec(ms: number): number {
  return ms / 1000;
}

/** Words for draw/karaoke; `null` if this cue must not use per-word follow. */
function timedWordsForCue(cue: CaptionCue): TimedDrawWord[] | null {
  if (!cueHasWordTimings(cue)) return null;
  return cue.words!
    .filter(isValidWordTiming)
    .map((w) => ({
      text: w.text.trim(),
      startSec: msToSec(w.startMs),
      endSec: msToSec(w.endMs),
      leadingSpace: Boolean(w.leadingSpace),
    }));
}

function pickCueIndexAtTimeSec(cues: CaptionCue[], timeSec: number): number {
  if (cues.length === 0) return -1;
  if (timeSec < msToSec(cues[0]!.startMs)) return 0;

  for (let k = 0; k < cues.length; k += 1) {
    const c = cues[k]!;
    const cEnd = msToSec(c.endMs);
    const next = cues[k + 1];
    const nextStart = next ? msToSec(next.startMs) : Number.POSITIVE_INFINITY;
    const displayUntil = Math.max(
      cEnd,
      Math.min(cEnd + CUE_POST_ROLL_SEC, nextStart - CUE_NEXT_LEAD_IN_SEC),
    );
    if (timeSec >= msToSec(c.startMs) && timeSec < displayUntil) return k;
  }
  return cues.length - 1;
}

function wordsOverlappingCue(words: TimedDrawWord[], cue: CaptionCue): TimedDrawWord[] {
  const lo = msToSec(cue.startMs) - 1e-3;
  const hi = msToSec(cue.endMs) + 1e-3;
  return words.filter((w) => w.endSec > lo && w.startSec < hi);
}

/** Word indices sorted for the karaoke hand-off scan (by start, then end). */
function karaokeOrder(words: TimedDrawWord[]): number[] {
  return words
    .map((_, i) => i)
    .sort((ia, ib) => {
      const da = words[ia]!.startSec - words[ib]!.startSec;
      if (Math.abs(da) > 1e-6) return da;
      return words[ia]!.endSec - words[ib]!.endSec;
    });
}

/** Karaoke index — hand off at the next token's start (avoids Whisper end tails). */
function pickActiveWordIndex(
  words: TimedDrawWord[],
  order: number[],
  timeSec: number,
): number {
  const eps = WORD_SYNC_EPS_SEC;
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k]!;
    const cur = words[i]!;
    const lo = cur.startSec - eps;
    let hi: number;

    if (k < order.length - 1) {
      const nx = words[order[k + 1]!]!;
      if (nx.startSec > cur.startSec + 0.008) {
        hi = nx.startSec;
      } else {
        hi = Math.min(
          Math.max(cur.endSec, cur.startSec + WORD_PARTITION_MIN_SEC),
          nx.endSec,
        );
      }
      if (hi <= lo + 1e-6) {
        hi = Math.max(cur.endSec, lo + WORD_PARTITION_MIN_SEC);
      }
    } else {
      hi = cur.endSec + eps;
    }

    if (timeSec >= lo && timeSec < hi) return i;
  }
  return -1;
}

/** Per-cue draw prep cached by cue identity (time-independent fields only). */
type CuePrep =
  | { readonly kind: "words"; readonly words: TimedDrawWord[]; readonly order: number[] }
  /** Cue lacks usable Whisper timings → draw its text, no karaoke. */
  | { readonly kind: "no-timings" }
  /** Has timings but none overlap the cue window → draw nothing. */
  | { readonly kind: "empty" };

const NO_TIMINGS: CuePrep = { kind: "no-timings" };
const EMPTY: CuePrep = { kind: "empty" };

const cuePrepCache = new WeakMap<CaptionCue, CuePrep>();

function prepareCue(cue: CaptionCue): CuePrep {
  const timed = timedWordsForCue(cue);
  if (!timed) return NO_TIMINGS;
  const words = wordsOverlappingCue(timed, cue);
  if (words.length === 0) return EMPTY;
  return { kind: "words", words, order: karaokeOrder(words) };
}

function preparedCue(cue: CaptionCue): CuePrep {
  let prep = cuePrepCache.get(cue);
  if (prep === undefined) {
    prep = prepareCue(cue);
    cuePrepCache.set(cue, prep);
  }
  return prep;
}

export function resolveActiveCueWords(
  cues: CaptionCue[],
  timeMs: number,
): { cue: CaptionCue; words: TimedDrawWord[]; activeWordIndex: number } | null {
  const timeSec = msToSec(timeMs);
  const cueIndex = pickCueIndexAtTimeSec(cues, timeSec);
  const cue = cues[cueIndex];
  if (!cue) return null;

  const prep = preparedCue(cue);
  if (prep.kind === "empty") return null;
  if (prep.kind === "no-timings") return { cue, words: [], activeWordIndex: -1 };

  const activeWordIndex = pickActiveWordIndex(prep.words, prep.order, timeSec);
  return { cue, words: prep.words, activeWordIndex };
}

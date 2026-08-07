export const MIN_SILENCE_CUT_DURATION_SEC = 1;

export const SILENCE_CUT_PAD_SEC = 0.25;

export const MIN_KEPT_AFTER_SILENCE_CUTS_SEC = 0.5;

export type SilenceCutSpan = {
  start: number;
  end: number;
};

export type SilenceCutStatus =
  | "ok"
  | "no-duration"
  | "no-silence"
  | "no-slots"
  | "failed";

export type SilenceCutResult = {
  status: SilenceCutStatus;
  cuts: SilenceCutSpan[];
};

function spansOverlap(a: SilenceCutSpan, b: SilenceCutSpan): boolean {
  return a.end > b.start && a.start < b.end;
}

function toSeconds(
  silences: Array<{ startMs: number; endMs: number }>,
  duration: number,
): SilenceCutSpan[] {
  return silences
    .filter((s) => Number.isFinite(s.startMs) && s.startMs >= 0)
    .map((s) => {
      const start = Math.max(0, Math.min(duration, s.startMs / 1000));
      const rawEnd = Number.isFinite(s.endMs) ? s.endMs / 1000 : duration;
      return { start, end: Math.max(start, Math.min(duration, rawEnd)) };
    })
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
}

export function buildSilenceCutSuggestions(params: {
  silences: Array<{ startMs: number; endMs: number }>;
  duration: number;
  reservedSpans?: SilenceCutSpan[];
  minSilenceSec?: number;
  padSec?: number;
}): SilenceCutResult {
  const {
    silences,
    duration,
    reservedSpans = [],
    minSilenceSec = MIN_SILENCE_CUT_DURATION_SEC,
    padSec = SILENCE_CUT_PAD_SEC,
  } = params;

  if (!(duration > 0)) {
    return { status: "no-duration", cuts: [] };
  }

  const candidates = toSeconds(silences, duration).filter(
    (s) => s.end - s.start >= minSilenceSec,
  );
  if (candidates.length === 0) {
    return { status: "no-silence", cuts: [] };
  }

  const reserved = reservedSpans
    .filter((s) => s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }));

  const cuts: SilenceCutSpan[] = [];
  let removed = 0;

  for (const span of candidates) {
    const start = span.start + padSec;
    const end = span.end - padSec;
    if (end - start <= 0) continue;

    const cut = { start, end };
    if (reserved.some((span) => spansOverlap(cut, span))) continue;
    if (
      duration - (removed + (end - start)) <
      MIN_KEPT_AFTER_SILENCE_CUTS_SEC
    ) {
      continue;
    }

    reserved.push(cut);
    cuts.push(cut);
    removed += end - start;
  }

  if (cuts.length === 0) {
    return { status: "no-slots", cuts: [] };
  }

  return { status: "ok", cuts };
}

import type { CaptionCue } from './types';
const MIN_MS = 200;

/** Resize/move within the current free slot, never through a neighbouring cue. */
export function retimeCaption(cues: CaptionCue[], id: string, startMs: number, endMs: number, durationMs: number, mode: 'move' | 'start' | 'end'): CaptionCue[] {
  const cue = cues.find(c => c.id === id);
  if (!cue || ![startMs, endMs, durationMs].every(Number.isFinite)) return cues;
  const previous = cues.filter(c => c.id !== id && c.endMs <= cue.startMs).sort((a,b) => b.endMs-a.endMs)[0];
  const next = cues.filter(c => c.id !== id && c.startMs >= cue.endMs).sort((a,b) => a.startMs-b.startMs)[0];
  const lo = previous?.endMs ?? 0;
  const hi = Math.floor(next?.startMs ?? durationMs);
  const min = Math.min(MIN_MS, cue.endMs - cue.startMs);
  let start = Math.round(startMs), end = Math.round(endMs);
  if (mode === 'move') {
    const length = Math.max(min, end-start);
    start = Math.max(lo, Math.min(hi-length, start)); end = start + length;
  } else if (mode === 'start') {
    start = Math.max(lo, Math.min(cue.endMs-min, start)); end = cue.endMs;
  } else {
    start = cue.startMs; end = Math.max(start+min, Math.min(hi, end));
  }
  if (start === cue.startMs && end === cue.endMs) return cues;
  return cues.map(c => c.id === id ? { ...c, startMs: start, endMs: end, words: undefined, manual: true } : c);
}

/** Prefer the playhead, then the next free slot; return null when the track is full. */
export function freeCaptionRange(cues: CaptionCue[], playheadMs: number, durationMs: number): { startMs: number; endMs: number } | null {
  if (!Number.isFinite(durationMs) || durationMs < MIN_MS) return null;
  const sorted = [...cues].sort((a,b) => a.startMs-b.startMs);
  const gaps: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const cue of sorted) {
    if (cue.startMs - cursor >= MIN_MS) gaps.push({ startMs: cursor, endMs: cue.startMs });
    cursor = Math.max(cursor, cue.endMs);
  }
  if (durationMs - cursor >= MIN_MS) gaps.push({ startMs: cursor, endMs: Math.floor(durationMs) });
  const at = Math.max(0, Math.min(durationMs, Math.round(playheadMs)));
  const gap = gaps.find(g => at >= g.startMs && at <= g.endMs-MIN_MS) ?? gaps.find(g => g.startMs >= at) ?? gaps[gaps.length-1];
  if (!gap) return null;
  const startMs = Math.max(gap.startMs, Math.min(gap.endMs-MIN_MS, at));
  return { startMs, endMs: Math.min(gap.endMs, startMs + 3000) };
}

import type { CaptionCue } from './types';

/** Manual captions use original-recording time, just like Whisper captions. */
export function saveManualCue(
  cues: CaptionCue[],
  draft: { id: string; text: string; startMs: number; endMs: number },
  durationMs: number,
): { cues: CaptionCue[]; error: string | null } {
  const text = draft.text.trim();
  const startMs = Math.round(draft.startMs);
  const endMs = Math.round(draft.endMs);
  const fail = (error: string) => ({ cues, error });
  if (!text) return fail('Enter some text.');
  if (![startMs, endMs, durationMs].every(Number.isFinite) || durationMs <= 0)
    return fail('Wait for the recording to load and enter valid times.');
  if (startMs < 0 || endMs <= startMs || endMs > durationMs)
    return fail('End must be after start and within the recording.');
  if (cues.some(c => c.id !== draft.id && startMs < c.endMs && endMs > c.startMs))
    return fail('This overlaps another caption. Adjust the start or end time.');
  // Manual timing/text replaces any stale word timings on this cue only.
  const cue: CaptionCue = { id: draft.id, text, startMs, endMs, manual: true,
    anchor: cues.find(c => c.id === draft.id)?.anchor };
  return {
    cues: [...cues.filter(c => c.id !== draft.id), cue].sort((a, b) => a.startMs - b.startMs),
    error: null,
  };
}

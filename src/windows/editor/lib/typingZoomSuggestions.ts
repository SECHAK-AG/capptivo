import type { CursorClickSample } from '../../../engine/zoomMotion';
import { buildClickZoomSuggestions, type SuggestedZoomSpan } from './zoomSuggestionUtils.ts';

/** Hold a field through natural typing pauses, splitting when focus moves to another field. */
export function buildTypingZoomSuggestions(samples: CursorClickSample[], duration: number,
  reserved: Array<{ start: number; end: number }> = []): SuggestedZoomSpan[] {
  const valid = samples.filter(s => [s.t,s.x,s.y].every(Number.isFinite)
    && s.t >= 0 && s.t <= duration && s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1).sort((a,b) => a.t-b.t);
  const groups: CursorClickSample[][] = [];
  for (const sample of valid) {
    const group = groups[groups.length-1]; const last = group?.[group.length-1];
    if (!last || sample.t-last.t > 1.4 || Math.hypot(sample.x-last.x, sample.y-last.y) > 0.2) groups.push([sample]);
    else group.push(sample);
  }
  const spans: SuggestedZoomSpan[] = [];
  for (const group of groups) {
    if (group.length < 2) continue; // A stray key doesn't deserve a camera move.
    const first = group[0], last = group[group.length-1];
    let start = Math.max(0, first.t-0.5), end = Math.min(duration, Math.max(first.t+1.3, last.t+1.2));
    // Authored zooms win; keep only the part of this burst around the first key.
    for (const block of reserved) {
      if (block.start >= end || block.end <= start) continue;
      if (block.end <= first.t) start = Math.max(start, block.end);
      else if (block.start > first.t) end = Math.min(end, block.start);
      else { end = start; break; }
    }
    if (end-start < 1.2) continue;
    // A new field takes over from the previous generated hold, rather than
    // disappearing because the old field's trailing padding overlaps it.
    const previous = spans[spans.length-1];
    if (previous && previous.end > start) {
      previous.end = start;
      if (previous.end-previous.start < 1.2) spans.pop();
    }
    spans.push({ start, end, focus: {
      x: group.reduce((sum,s) => sum+s.x,0)/group.length,
      y: group.reduce((sum,s) => sum+s.y,0)/group.length,
    } });
  }
  return spans;
}

export function buildAutomaticZoomSuggestions(params: {
  clicks: CursorClickSample[]; typing: CursorClickSample[]; duration: number;
  reserved?: Array<{ start: number; end: number }>;
}): { status: 'ok' | 'no-duration' | 'no-clicks' | 'no-slots'; suggestions: Array<SuggestedZoomSpan & { typing?: true }> } {
  if (!(params.duration > 0)) return { status: 'no-duration', suggestions: [] };
  const typed = buildTypingZoomSuggestions(params.typing, params.duration, params.reserved).map(s => ({ ...s, typing: true as const }));
  const clicked = buildClickZoomSuggestions({ clicks: params.clicks, duration: params.duration, reservedSpans: [...(params.reserved ?? []), ...typed] });
  const suggestions = [...typed, ...clicked.suggestions].sort((a,b) => a.start-b.start);
  return { status: suggestions.length ? 'ok' : clicked.status === 'no-clicks' && !params.typing.length ? 'no-clicks' : 'no-slots', suggestions };
}

import { removeSegmentById, getNextPlayableTime, type TrimSegment } from '../../../engine/trimSegments.ts';
/** Keep a valid playable timeline; an empty segment list means full video in legacy exports. */
export function removeVideoClip(segments: TrimSegment[], id: string, currentTime: number): { segments: TrimSegment[]; currentTime: number } | null {
  const next = removeSegmentById(segments, id);
  if (!next.length || next.length === segments.length) return null;
  return { segments: next, currentTime: getNextPlayableTime(next, currentTime) ?? next[next.length-1].end };
}

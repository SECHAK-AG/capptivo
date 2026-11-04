import { findSegmentIndexAtTime, getNextPlayableTime, type TrimSegment } from '../../../engine/trimSegments.ts';

/** Never restart a pending seek: some WebViews still report the pre-cut time. */
export function previewCutAction(segments: TrimSegment[], time: number, seeking: boolean):
  { kind: 'none' } | { kind: 'seek' | 'stop'; time: number } {
  if (seeking || !segments.length || findSegmentIndexAtTime(segments, time) >= 0) return { kind: 'none' };
  const next = getNextPlayableTime(segments, time);
  return next !== null ? { kind: 'seek', time: next }
    : { kind: 'stop', time: segments[segments.length-1].end };
}

/** Retain the last composed picture through the decoder's temporary seek gap. */
export function previewFrameReady(video: { readyState: number; seeking: boolean } | null): boolean {
  return video === null || (!video.seeking && video.readyState >= 2);
}

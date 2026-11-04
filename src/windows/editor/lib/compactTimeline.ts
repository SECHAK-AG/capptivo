import type { TrimSegment } from '../../../engine/trimSegments';
export type TimelineClip = TrimSegment & { timelineStart: number; timelineEnd: number };
/** Source timestamps remain authoritative for zoom/cursor/captions and export. */
export function compactTimeline(segments: TrimSegment[], sourceDuration: number) {
  const kept = segments.length ? segments : [{ id: 'full', start: 0, end: sourceDuration }];
  let total = 0;
  const clips: TimelineClip[] = kept.map(clip => {
    const timelineStart = total;
    total += Math.max(0, clip.end-clip.start);
    return { ...clip, timelineStart, timelineEnd: total };
  });
  return { clips, duration: total };
}
export function sourceToTimeline(clips: TimelineClip[], sourceTime: number): number {
  for (const clip of clips) {
    if (sourceTime <= clip.start) return clip.timelineStart;
    if (sourceTime <= clip.end) return clip.timelineStart + sourceTime-clip.start;
  }
  return clips[clips.length-1]?.timelineEnd ?? 0;
}
/** Start edges seek the next clip at a cut; end edges stay on the previous clip. */
export function timelineToSource(clips: TimelineClip[], timelineTime: number, edge: 'start' | 'end' = 'start'): number {
  const time = Math.max(0, timelineTime);
  for (let i=0; i<clips.length; i++) {
    const clip = clips[i];
    if (time < clip.timelineEnd || (edge === 'end' && time === clip.timelineEnd) || i === clips.length-1)
      return clip.start + Math.max(0, Math.min(clip.end-clip.start, time-clip.timelineStart));
  }
  return 0;
}
export function projectTimelineRange(clips: TimelineClip[], start: number, end: number) {
  const left = sourceToTimeline(clips, start), right = sourceToTimeline(clips, end);
  return { start: left, end: right, duration: Math.max(0, right-left) };
}

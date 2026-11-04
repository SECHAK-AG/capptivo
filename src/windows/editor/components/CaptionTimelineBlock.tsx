import type { CaptionCue } from '@/captions/types';
import { TimelineResizePill, type TimelineResizeEdge } from './TimelineResizePill';
import { cn } from '../lib/cn';

export function CaptionTimelineBlock({ cue, selected, onResizePointerDown }: {
  cue: CaptionCue; selected: boolean;
  onResizePointerDown: (edge: TimelineResizeEdge, e: React.PointerEvent) => void;
}) {
  return <div title={`${cue.text} · Drag to move; drag edges to change duration`} className={cn(
    'group/zoom relative flex h-full w-full items-center overflow-hidden rounded-lg border px-4 text-xs text-white',
    selected ? 'border-sky-300 bg-sky-700' : 'border-transparent bg-sky-900 hover:bg-sky-800',
  )}>
    <TimelineResizePill edge="start" hoverGroup="zoom" show={selected} onPointerDown={e => onResizePointerDown('start', e)} />
    <span className="pointer-events-none truncate">T · {cue.text}</span>
    <TimelineResizePill edge="end" hoverGroup="zoom" show={selected} onPointerDown={e => onResizePointerDown('end', e)} />
  </div>;
}

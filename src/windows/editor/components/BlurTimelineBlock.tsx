import { Eye, EyeOff } from 'lucide-react';
import { TimelineResizePill, type TimelineResizeEdge } from './TimelineResizePill';
import { cn } from '../lib/cn';
export function BlurTimelineBlock({ enabled, selected, index, onToggle, onResize }: {
  enabled: boolean; selected: boolean; index: number; onToggle: () => void;
  onResize: (edge: TimelineResizeEdge, event: React.PointerEvent) => void;
}) {
  return <div className={cn('group/zoom relative flex h-full w-full items-center justify-center gap-1 overflow-hidden rounded-lg border px-3 text-xs text-white',
    enabled ? 'bg-amber-900' : 'bg-neutral-700 opacity-60', selected ? 'border-amber-200' : 'border-transparent')}>
    <TimelineResizePill edge="start" hoverGroup="zoom" show={selected} onPointerDown={e => onResize('start', e)} />
    <button type="button" title={enabled ? 'Disable blur' : 'Enable blur'} aria-label={`Toggle blur ${index+1}`} aria-pressed={enabled}
      className="shrink-0 p-1" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onToggle(); }}>
      {enabled ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
    </button>
    <span className="pointer-events-none truncate">Blur {index+1}</span>
    <TimelineResizePill edge="end" hoverGroup="zoom" show={selected} onPointerDown={e => onResize('end', e)} />
  </div>;
}

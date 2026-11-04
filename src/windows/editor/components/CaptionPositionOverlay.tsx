import { useMemo, useRef } from 'react';
import { resolveActiveCueWords, playbackTimeMs } from '@/captions/captionTiming';
import { measureCaptionBounds } from '@/captions/drawCaptions';
import { captionBlockBounds } from '@/captions/settings';
import { useEditorStore } from '../store';
import { cn } from '../lib/cn';

/** Transparent hitbox; the compositor remains the single renderer of the text. */
export function CaptionPositionOverlay({ width, height }: { width: number; height: number }) {
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; left: number; top: number; width: number; height: number } | null>(null);
  const context = useMemo(() => document.createElement('canvas').getContext('2d'), []);
  const cues = useEditorStore(s => s.captions);
  const settings = useEditorStore(s => s.captionSettings);
  const currentTime = useEditorStore(s => s.isPlaying ? 0 : s.currentTime);
  const playing = useEditorStore(s => s.isPlaying);
  const exporting = useEditorStore(s => s.exporting);
  const selected = useEditorStore(s => s.selectedCaptionId);
  if (playing || exporting || !settings.enabled || !context) return null;
  const resolved = resolveActiveCueWords(cues, playbackTimeMs(currentTime*1000, settings.timingOffsetMs));
  const cue = resolved?.cue;
  if (playing || exporting || !settings.enabled || !cue || !context || !cue.text.trim()) return null;
  const box = measureCaptionBounds(context, cue, settings, width, height);
  const finish = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.pointer !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    useEditorStore.getState().endTimelineEdit();
  };
  return <div ref={layer} className="pointer-events-none absolute inset-0 z-30">
    <button type="button" aria-label="Move caption in video" title="Drag to position this caption"
      className={cn('pointer-events-auto absolute touch-none cursor-move rounded border-2 border-transparent bg-transparent outline-none hover:border-sky-300 focus-visible:border-sky-300', selected === cue.id && 'border-sky-300/80')}
      style={{ left: `${box.left/width*100}%`, top: `${box.top/height*100}%`, width: `${box.width/width*100}%`, height: `${box.height/height*100}%` }}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const s = useEditorStore.getState(); s.selectCaption(cue.id, false); s.beginTimelineEdit();
        drag.current = { id: cue.id, pointer: e.pointerId, x: e.clientX, y: e.clientY, ...box };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const active = drag.current, rect = layer.current?.getBoundingClientRect();
        if (!active || active.pointer !== e.pointerId || !rect?.width || !rect.height) return;
        const anchor = {
          x: (active.left+active.width/2+(e.clientX-active.x)*width/rect.width)/width,
          y: (active.top+active.height/2+(e.clientY-active.y)*height/rect.height)/height,
        };
        const placed = captionBlockBounds(width, height, active.width, active.height, settings, anchor);
        useEditorStore.getState().setCaptionAnchor(active.id, {
          x: (placed.left+placed.width/2)/width, y: (placed.top+placed.height/2)/height,
        });
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={e => {
        const directions: Record<string, [number, number]> = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] };
        const delta = directions[e.key]; if (!delta) return;
        e.preventDefault(); e.stopPropagation(); const s = useEditorStore.getState();
        s.selectCaption(cue.id, false); s.beginTimelineEdit();
        const step = e.shiftKey ? 10 : 1;
        s.setCaptionAnchor(cue.id, { x: (box.left+box.width/2+delta[0]*step)/width, y: (box.top+box.height/2+delta[1]*step)/height });
        s.endTimelineEdit();
      }}
    />
  </div>;
}

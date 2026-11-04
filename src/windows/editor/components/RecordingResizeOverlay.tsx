import { useShallow } from 'zustand/react/shallow';
import { useEffect, useRef, useState } from 'react';
import { computeCameraTransform, getCompositionLayout } from '@/engine';
import { useEditorStore } from '../store';
import { resolveRecordingLayoutParams, videoRectToLayoutFrac } from '../lib/composition';
import { getZoomPanAtTime } from '../lib/zoomCache';
import { recordingScaleFromDrag } from '../lib/recordingResize';
import { resolveZoomReactiveState } from '../render/renderFrame';

/** Handles live above the canvas; the compositor still owns all rendered pixels. */
export function RecordingResizeOverlay({ width, height }: { width: number; height: number }) {
  const state = useEditorStore(useShallow(s => ({
    isPlaying: s.isPlaying, exporting: s.exporting, screenUrl: s.screenUrl, look: s.look,
    backgroundImage: s.backgroundImage, backgroundType: s.backgroundType,
    aspectRatioPresetId: s.aspectRatioPresetId, sourceAspect: s.sourceAspect,
    sourceVideoSize: s.sourceVideoSize, screenContentCrop: s.screenContentCrop,
    zoomFragments: s.zoomFragments, recordingMetadata: s.recordingMetadata,
    currentTime: s.isPlaying ? 0 : s.currentTime, setLook: s.setLook, setRecordingPosition: s.setRecordingPosition,
    beginTimelineEdit: s.beginTimelineEdit,
  })));
  const [editing, setEditing] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; vx: number; vy: number; scale: number; kind: 'resize' | 'move'; offsetX: number; offsetY: number } | null>(null);
  useEffect(() => {
    if ((state.isPlaying || state.exporting) && drag.current) {
      drag.current = null; useEditorStore.getState().endTimelineEdit();
    }
  }, [state.isPlaying, state.exporting]);
  useEffect(() => () => {
    if (drag.current) { drag.current = null; useEditorStore.getState().endTimelineEdit(); }
  }, []);
  if (state.isPlaying || state.exporting || !state.screenUrl) return null;
  const scale = state.look.recordingScale ?? 1;
  const hasBackground = state.backgroundImage !== null;
  const params = resolveRecordingLayoutParams({
    presetId: state.aspectRatioPresetId, sourceAspect: state.sourceAspect,
    sourceVideoSize: state.sourceVideoSize, hasSelectedBackground: hasBackground,
    hasImageBackground: hasBackground && state.backgroundType === 'image',
    devicePadding: state.look.devicePadding, screenContentCrop: state.screenContentCrop,
  });
  const { video } = getCompositionLayout(params.sourceAspect, width, height, params.devicePadding, scale);
  const zoom = getZoomPanAtTime(state.zoomFragments, state.recordingMetadata, state.screenContentCrop, state.currentTime,
    { video: videoRectToLayoutFrac(video, width, height) });
  const active = state.zoomFragments.find(f => state.currentTime >= f.start && state.currentTime <= f.end) ?? null;
  const reactive = resolveZoomReactiveState(active, state.currentTime);
  const camera = computeCameraTransform({ stageWidth: width, stageHeight: height, videoRect: video,
    focus: zoom, scale: zoom.scale, targetScale: reactive.zoomTargetScale,
    recordingOffsetX: state.look.recordingOffsetX, recordingOffsetY: state.look.recordingOffsetY });
  const box = { x: video.x * camera.scale + camera.x, y: video.y * camera.scale + camera.y,
    width: video.width * camera.scale, height: video.height * camera.scale };
  const finish = (e: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    useEditorStore.getState().endTimelineEdit();
  };
  return <div ref={layer} className="pointer-events-none absolute inset-0 z-20"
    onKeyDown={e => { if (e.key === 'Escape' && editing) { e.stopPropagation(); setEditing(false); } }}>
    <div className="pointer-events-auto absolute left-2 top-2 z-10 flex gap-1 rounded bg-black/75 p-1 text-xs text-white">
      <button type="button" className="rounded px-2 py-1 hover:bg-white/20" aria-pressed={editing}
        onClick={() => setEditing(!editing)}>{editing ? 'Done positioning' : 'Position video'}</button>
      {editing && <button type="button" className="rounded px-2 py-1 hover:bg-white/20" onClick={() => { state.beginTimelineEdit(); state.setLook('recordingScale', 1); state.setRecordingPosition(0, 0); useEditorStore.getState().endTimelineEdit(); }}>Reset</button>}
    </div>
    {editing && <>
      <button type="button" aria-label="Move recording" title="Drag to move the recording" className="pointer-events-auto absolute cursor-move touch-none border border-sky-300 bg-transparent"
        onPointerDown={e => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation(); state.beginTimelineEdit();
          drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, vx: 0, vy: 0, scale, kind: 'move',
            offsetX: state.look.recordingOffsetX ?? 0, offsetY: state.look.recordingOffsetY ?? 0 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={e => {
          const start = drag.current, rect = layer.current?.getBoundingClientRect();
          if (!start || start.kind !== 'move' || start.pointer !== e.pointerId || !rect?.width || !rect.height) return;
          state.setRecordingPosition(start.offsetX + (e.clientX-start.x)/rect.width, start.offsetY + (e.clientY-start.y)/rect.height);
        }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
        onKeyDown={e => {
          const arrows: Record<string, [number,number]> = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] };
          const direction = arrows[e.key]; if (!direction) return;
          e.preventDefault(); e.stopPropagation(); const step = e.shiftKey ? 10 : 1;
          state.setRecordingPosition((state.look.recordingOffsetX ?? 0) + direction[0]*step/width,
            (state.look.recordingOffsetY ?? 0) + direction[1]*step/height);
        }} style={{ left: `${box.x / width * 100}%`, top: `${box.y / height * 100}%`, width: `${box.width / width * 100}%`, height: `${box.height / height * 100}%` }} />
      {([-1, 1] as const).flatMap(sx => ([-1, 1] as const).map(sy => {
        const x = box.x + (sx + 1) / 2 * box.width;
        const y = box.y + (sy + 1) / 2 * box.height;
        return <button key={`${sx}:${sy}`} type="button" aria-label="Resize recording" title="Drag to resize · arrow keys adjust size"
          className="pointer-events-auto absolute size-4 -translate-x-1/2 -translate-y-1/2 touch-none rounded-sm border-2 border-white bg-sky-500 shadow"
          style={{ left: `clamp(10px, ${x / width * 100}%, calc(100% - 10px))`, top: `clamp(48px, ${y / height * 100}%, calc(100% - 10px))`, cursor: sx === sy ? 'nwse-resize' : 'nesw-resize' }}
          onPointerDown={e => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation(); state.beginTimelineEdit();
            drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, vx: sx * box.width / 2, vy: sy * box.height / 2, scale, kind: 'resize', offsetX: 0, offsetY: 0 };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={e => {
            const start = drag.current, rect = layer.current?.getBoundingClientRect();
            if (!start || start.kind !== 'resize' || start.pointer !== e.pointerId || !rect?.width || !rect.height) return;
            const dx = (e.clientX - start.x) * width / rect.width;
            const dy = (e.clientY - start.y) * height / rect.height;
            state.setLook('recordingScale', recordingScaleFromDrag(start.scale, start.vx, start.vy, dx, dy));
          }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); return; }
            const delta = ['ArrowUp', 'ArrowRight'].includes(e.key) ? 1 : ['ArrowDown', 'ArrowLeft'].includes(e.key) ? -1 : 0;
            if (!delta) return;
            e.preventDefault(); e.stopPropagation(); state.setLook('recordingScale', scale + delta * (e.shiftKey ? 0.1 : 0.01));
          }} />;
      }))}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/75 px-2 py-1 text-xs text-white">{Math.round(scale * 100)}% · Drag image to move · corners to resize</div>
    </>}
  </div>;
}

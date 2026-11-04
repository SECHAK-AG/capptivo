import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useEditorStore } from '../store';
import { SectionLabel } from './ui';

export function ManualCaptionEditor() {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const captions = useEditorStore(s => s.captions);
  const selectedCaptionId = useEditorStore(s => s.selectedCaptionId);
  const selected = captions.find(c => c.id === selectedCaptionId);
  const selectCaption = useEditorStore(s => s.selectCaption);
  const duration = useEditorStore(s => s.duration);
  const currentTime = useEditorStore(s => s.currentTime);
  const generating = useEditorStore(s => s.captionGenerating);
  const save = useEditorStore(s => s.saveManualCaption);
  const remove = useEditorStore(s => s.removeManualCaption);
  const seek = useEditorStore(s => s.setCurrentTime);
  const play = useEditorStore(s => s.setPlaying);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('3');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEditingId(selectedCaptionId);
    setText(selected?.text ?? '');
    setError(null);
    if (selectedCaptionId) { textRef.current?.focus(); textRef.current?.select(); }
  }, [selectedCaptionId]);
  useEffect(() => {
    if (!selected) return;
    setStart(String(selected.startMs / 1000)); setEnd(String(selected.endMs / 1000));
  }, [selected?.startMs, selected?.endMs]);
  const field = 'w-full rounded-md border border-border bg-background p-2 text-xs';
  const reset = () => { setEditingId(null); setText(''); setError(null); };
  const usePlayhead = () => {
    setStart(currentTime.toFixed(2));
    setEnd(Math.min(duration, currentTime + 3).toFixed(2));
  };
  const submit = () => {
    const failure = save({ id: editingId ?? crypto.randomUUID(), text,
      startMs: start.trim() ? Number(start) * 1000 : NaN,
      endMs: end.trim() ? Number(end) * 1000 : NaN });
    if (failure) { setError(failure); return; }
    play(false); seek(Number(start)); if (!editingId) reset();
  };
  return <section className="space-y-3 rounded-lg border border-border p-3">
    <SectionLabel>Manual captions</SectionLabel>
    <p className="text-[11px] text-muted-foreground">Add your own text — no speech or model download needed. Use + Text on the timeline. Drag a blue block to move it, or its edges to change duration. Pause the video and drag the text in the preview to position it. Text saves when you leave the field. Font and colour are shared; placement is individual.</p>
    {selected?.anchor && <Button type="button" size="sm" variant="outline" onClick={() => {
      const s = useEditorStore.getState(); s.beginTimelineEdit(); s.setCaptionAnchor(selected.id); s.endTimelineEdit();
    }}>Reset placement</Button>}
    <fieldset disabled={generating || !(duration > 0)} className="space-y-2 disabled:opacity-50">
      <label className="block space-y-1 text-xs">Text
        <textarea ref={textRef} className={field} rows={3} value={text} placeholder="What if screws were sold as luxury goods?" onChange={e => setText(e.target.value)} onBlur={() => {
          if (!editingId || !text.trim()) return;
          const cue = useEditorStore.getState().captions.find(c => c.id === editingId);
          if (!cue || cue.text === text.trim()) return;
          setError(save({ id: editingId, text, startMs: cue.startMs, endMs: cue.endMs }));
        }} />
      </label>
      <details><summary className="cursor-pointer text-xs text-muted-foreground">Original recording time (optional)</summary>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs">Start (seconds)<input className={field} type="number" min="0" max={duration} step="0.1" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="space-y-1 text-xs">End (seconds)<input className={field} type="number" min="0" max={duration} step="0.1" value={end} onChange={e => setEnd(e.target.value)} /></label>
      </div>
      <Button size="sm" variant="outline" type="button" onClick={usePlayhead}>Start at playhead · 3 seconds</Button>
      </details>
      {error && <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" type="button" onClick={submit}>{editingId ? 'Save changes' : 'Add caption'}</Button>
        {editingId && <Button size="sm" variant="ghost" type="button" onClick={reset}>Cancel</Button>}
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {captions.map(cue => <div key={cue.id} className="space-y-1 rounded border border-border p-2">
          <button type="button" className="block text-left text-xs underline" onClick={() => { play(false); seek(cue.startMs / 1000); }}>{(cue.startMs / 1000).toFixed(2)}–{(cue.endMs / 1000).toFixed(2)} s · Preview</button>
          <p className="whitespace-pre-wrap break-words text-xs">{cue.text}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => selectCaption(cue.id)}>Edit</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { remove(cue.id); if (editingId === cue.id) reset(); }}>Delete</Button>
          </div>
        </div>)}
      </div>
    </fieldset>
  </section>;
}

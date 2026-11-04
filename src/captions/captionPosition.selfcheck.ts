import { captionBlockBounds, DEFAULT_CAPTION_SETTINGS } from './settings.ts';
import { measureCaptionBounds, drawCaptions, captionFrameKey } from './drawCaptions.ts';
import { saveManualCue } from './manualCues.ts';
import { retimeCaption } from './timelineCues.ts';
import type { CaptionCue } from './types.ts';
function assert(value: boolean, message: string) { if (!value) throw new Error(message); }
const style = { ...DEFAULT_CAPTION_SETTINGS, enabled: true };
const cue: CaptionCue = { id: 'text', text: 'Hello', startMs: 0, endMs: 3000, manual: true, anchor: { x: 0.2, y: 0.7 } };
const bounds = captionBlockBounds(1080, 1920, 200, 100, style, cue.anchor);
assert(bounds.left === 116 && bounds.top === 1294, 'normalized centre sets both horizontal and vertical position');
const offscreen = captionBlockBounds(1080, 1920, 200, 100, style, { x: -1, y: 2 });
assert(offscreen.left === 0 && offscreen.top === 1820, 'caption stays inside composition');
const invalid = captionBlockBounds(1080, 1920, 200, 100, style, { x: NaN, y: Infinity });
assert(Number.isFinite(invalid.left) && Number.isFinite(invalid.top), 'bad persisted anchor falls back');
const calls: { x: number; y: number }[] = [];
const context = {
  save() {}, restore() {}, measureText(text: string) { return { width: text.length*10 }; },
  fillText(_text: string, x: number, y: number) { calls.push({ x, y }); },
} as unknown as CanvasRenderingContext2D;
const measured = measureCaptionBounds(context, cue, style, 1080, 1920);
drawCaptions(context, [cue], style, 1080, 1920, 1000);
assert(calls.length === 1, 'actual export renderer draws the caption');
assert(calls[0].x >= measured.left && calls[0].x <= measured.left+measured.width, 'preview drag box matches drawn text horizontally');
assert(calls[0].y >= measured.top && calls[0].y <= measured.top+measured.height, 'preview drag box matches drawn text vertically');
const moved = { ...cue, anchor: { x: 0.8, y: 0.3 } };
assert(captionFrameKey([cue], style, 1080, 1920, 1000) !== captionFrameKey([moved], style, 1080, 1920, 1000), 'moving invalidates the compositor caption layer');
const edited = saveManualCue([cue], { id: cue.id, text: 'Edited', startMs: 0, endMs: 3000 }, 10000);
assert(edited.cues[0].anchor?.x === 0.2, 'editing text keeps its placement');
assert(retimeCaption([cue], cue.id, 4000, 7000, 10000, 'move')[0].anchor?.y === 0.7, 'timeline move keeps placement');
assert(JSON.parse(JSON.stringify(cue)).anchor.y === 0.7, 'placement survives project save/load');
console.log('captionPosition.selfcheck: ok');

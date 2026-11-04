import { retimeCaption, freeCaptionRange } from './timelineCues.ts';
import type { CaptionCue } from './types.ts';
import { DEFAULT_CAPTION_SETTINGS } from './settings.ts';
function assert(value: boolean, message: string) { if (!value) throw new Error(message); }
const cues: CaptionCue[] = [
  { id: 'a', text: 'A', startMs: 0, endMs: 1000 },
  { id: 'b', text: 'B', startMs: 2000, endMs: 4000 },
  { id: 'c', text: 'C', startMs: 6000, endMs: 7000 },
];
const move = (start: number) => retimeCaption(cues, 'b', start, start+2000, 8000, 'move')[1];
assert(move(-100).startMs === 1000, 'move stops at previous caption');
assert(move(9000).endMs === 6000, 'move stops at next caption');
assert(move(3500).startMs === 3500 && move(3500).endMs === 5500, 'drag retains duration');
assert(cues[1].startMs === 2000, 'input untouched');
const left = retimeCaption(cues, 'b', -100, 4000, 8000, 'start')[1];
assert(left.startMs === 1000 && left.endMs === 4000, 'left edge stretches up to neighbour');
const right = retimeCaption(cues, 'b', 2000, 9999, 8000, 'end')[1];
assert(right.endMs === 6000 && right.startMs === 2000, 'right edge stops at neighbour');
assert(retimeCaption(cues, 'b', 2000, 0, 8000, 'end')[1].endMs === 2200, 'minimum duration enforced');
assert(retimeCaption(cues, 'b', NaN, 4000, 8000, 'start') === cues, 'nonfinite drag ignored');
assert(freeCaptionRange([], 1000, 16000)?.endMs === 4000, 'new caption starts at playhead for three seconds');
assert(freeCaptionRange(cues, 2500, 8000)?.startMs === 4000, 'occupied playhead uses next free slot');
assert(freeCaptionRange([{ id: 'a', text: 'A', startMs: 0, endMs: 8000 }], 1, 8000) === null, 'full track gives no overlapping caption');
assert(freeCaptionRange([], 16000, 16000)?.endMs === 16000, 'playhead at end still yields a usable caption');
assert(DEFAULT_CAPTION_SETTINGS.position === 'top' && DEFAULT_CAPTION_SETTINGS.sentenceBackground === null, 'default is top headline with no box');
assert(DEFAULT_CAPTION_SETTINGS.textColor === '#ffffff' && DEFAULT_CAPTION_SETTINGS.fontSizePx === 72, 'default is large white text');
console.log('timelineCues.selfcheck: ok');

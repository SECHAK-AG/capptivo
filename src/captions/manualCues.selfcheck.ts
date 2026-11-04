import { resolveActiveCueWords } from "./captionTiming.ts";
import { saveManualCue } from './manualCues.ts';
import { DEFAULT_CAPTION_SETTINGS, parseCaptionSettings, captionBlockTop } from './settings.ts';
import type { CaptionCue } from './types.ts';
function assert(ok: boolean, message: string) { if (!ok) throw new Error(message); }
const original: CaptionCue[] = [{ id: 'a', text: 'Existing', startMs: 0, endMs: 1000,
  words: [{ text: 'Existing', startMs: 0, endMs: 1000 }] }];
const draft = { id: 'b', text: '  New caption  ', startMs: 1000, endMs: 4000 };
const saved = saveManualCue(original, draft, 5000);
assert(saved.error === null && saved.cues.length === 2, 'adjacent manual caption is added');
assert(saved.cues[1].text === 'New caption', 'text is trimmed');
assert(saved.cues[0] === original[0] && original.length === 1, 'unrelated cues preserved, input immutable');
for (const invalid of [
  { ...draft, text: ' ' }, { ...draft, startMs: NaN },
  { ...draft, startMs: -1 }, { ...draft, endMs: 6000 },
  { ...draft, endMs: 1000 }, { ...draft, startMs: 500 },
]) assert(saveManualCue(original, invalid, 5000).error !== null, 'invalid or overlapping cue rejected');
const edited = saveManualCue(original, { id: 'a', text: 'Changed', startMs: 100, endMs: 900 }, 5000);
assert(edited.error === null && edited.cues[0].words === undefined, 'editing removes stale word timings');
assert(saveManualCue(original, draft, 0).error !== null, 'unloaded recording rejected');
const style = { ...DEFAULT_CAPTION_SETTINGS, bottomOffsetPx: 48, position: "bottom" as const };
assert(parseCaptionSettings({}).position === 'bottom', 'legacy projects stay bottom aligned');
for (const position of ['top', 'center', 'bottom'] as const) {
  const roundTrip = parseCaptionSettings(JSON.parse(JSON.stringify({ ...style, position })));
  assert(roundTrip.position === position, 'placement survives save/load');
}
assert(captionBlockTop(1920, 100, { ...style, position: 'top' }) === 48, 'top placement');
assert(captionBlockTop(1920, 100, { ...style, position: 'center' }) === 910, 'center placement');
assert(captionBlockTop(1920, 100, style) === 1772, 'existing bottom placement');
assert(captionBlockTop(50, 100, style) === 0, 'small stages do not push text above canvas');
console.log('manualCues.selfcheck: ok');

const manual = saved.cues.filter(c => c.manual);
assert(resolveActiveCueWords(manual, 999) === null, 'manual text hidden before start');
assert(resolveActiveCueWords(manual, 1000)?.cue.text === 'New caption', 'manual text shown at start');
assert(resolveActiveCueWords(manual, 4000) === null, 'manual text hidden at end');
assert(resolveActiveCueWords(manual, 9000) === null, 'manual text does not stick after end');
const restored = JSON.parse(JSON.stringify(manual));
assert(resolveActiveCueWords(restored, 9000) === null, 'strict timing survives project save');

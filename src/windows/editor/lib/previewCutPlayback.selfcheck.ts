import { previewCutAction, previewFrameReady } from './previewCutPlayback.ts';
function assert(value: boolean, message: string) { if (!value) throw new Error(message); }
const clips = [{ id: 'a', start: 0, end: 2 }, { id: 'b', start: 5, end: 9 }];
const first = previewCutAction(clips, 2.1, false);
assert(first.kind === 'seek' && first.time === 5, 'first frame in removed section requests next kept clip');
for (let frame=0; frame<120; frame++) {
  assert(previewCutAction(clips, 2.1, true).kind === 'none', 'stale pre-seek time never restarts pending cut seek');
  assert(!previewFrameReady({ seeking: true, readyState: 1 }), 'decoder gap retains prior canvas frame');
}
assert(previewCutAction(clips, 5, false).kind === 'none', 'playback continues after seek completes');
assert(previewFrameReady({ seeking: false, readyState: 2 }), 'first decoded target frame paints normally');
assert(!previewFrameReady({ seeking: false, readyState: 1 }), 'metadata alone must not clear last frame');
const end = previewCutAction(clips, 9.1, false);
assert(end.kind === 'stop' && end.time === 9, 'stop at final kept clip');
assert(previewCutAction([], 2, false).kind === 'none', 'no edit list leaves uncut playback untouched');
console.log('previewCutPlayback.selfcheck: ok');

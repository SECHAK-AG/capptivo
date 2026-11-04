import { recordingScaleFromDrag } from './recordingResize.ts';
function assert(ok: boolean, message: string) { if (!ok) throw new Error(message); }
assert(recordingScaleFromDrag(1, 400, 225, 200, 112.5) === 1.5, 'outward drag enlarges from initial size');
assert(recordingScaleFromDrag(1, -400, -225, -200, -112.5) === 1.5, 'opposite corner has same outward behavior');
assert(recordingScaleFromDrag(1, 400, 225, -200, -112.5) === 0.5, 'inward drag shrinks proportionally');
assert(recordingScaleFromDrag(1.5, 600, 337.5, 0, 0) === 1.5, 'grab does not jump to a different size');
assert(recordingScaleFromDrag(1, 400, 225, 225, -400) === 1, 'perpendicular movement does not distort aspect');
assert(recordingScaleFromDrag(1, 400, 225, 9999, 9999) === 3, 'oversized drag respects export limit');
assert(recordingScaleFromDrag(1, 400, 225, -9999, -9999) === 0.5, 'crossing center never flips the picture');
console.log('recordingResize.selfcheck: ok');

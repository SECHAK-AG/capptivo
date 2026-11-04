import { removeVideoClip } from './clipEditing.ts';
import { createFullSegment, splitSegmentAtTime, normalizeSegments, totalKeptDuration, computeTrimGaps } from '../../../engine/trimSegments.ts';
function assert(value: boolean, message: string) { if (!value) throw new Error(message); }
const original = createFullSegment(10);
const split = splitSegmentAtTime(splitSegmentAtTime(original, 3, 0.2), 7, 0.2);
assert(split.length === 3, 'two cuts create three selectable clips');
const result = removeVideoClip(split, split[1].id, 4);
assert(result !== null && result.segments.length === 2, 'delete removes the selected middle piece');
assert(totalKeptDuration(result!.segments) === 6, 'output contains six seconds, no deleted footage');
assert(result!.currentTime === 7, 'playhead skips removed section');
assert(computeTrimGaps(result!.segments, 10)[0].start === 3, 'removed section can be restored');
assert(normalizeSegments(JSON.parse(JSON.stringify(split)), 10, 0.2).length === 3, 'cut boundaries survive project save/load');
assert(removeVideoClip(original, original[0].id, 0) === null, 'last clip cannot accidentally restore full recording through empty list');
assert(original.length === 1 && original[0].end === 10, 'original timeline stays unchanged for undo');
console.log('clipEditing.selfcheck: ok');

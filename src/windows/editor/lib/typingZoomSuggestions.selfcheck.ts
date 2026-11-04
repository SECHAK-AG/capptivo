import { buildAutomaticZoomSuggestions, buildTypingZoomSuggestions } from './typingZoomSuggestions.ts';
import { computeZoomKeyframes, type ZoomFragment, type RecordingMetadata } from '../../../engine/zoomMotion.ts';
function assert(value: boolean, message: string) { if (!value) throw new Error(message); }
const typing = [2,2.2,2.4,3,3.2].map(t => ({ t, x: 0.8, y: 0.8 }));
const spans = buildTypingZoomSuggestions(typing, 10);
assert(spans.length === 1 && spans[0].start === 1.5 && spans[0].end === 4.4, 'one padded typing burst');
assert(buildTypingZoomSuggestions([typing[0]], 10).length === 0, 'ignore stray key');
assert(buildTypingZoomSuggestions(typing, 10, [{ start: 0, end: 10 }]).length === 0, 'authored zoom wins');
const mixed = buildAutomaticZoomSuggestions({ clicks: [{ t: 2.1, x: 0.1, y: 0.1 }], typing, duration: 10 });
assert(mixed.suggestions.length === 1 && mixed.suggestions[0].typing === true, 'typing wins over overlapping mouse zoom');
const moved = [...typing, ...[6,6.2,6.4].map(t => ({ t, x: 0.2, y: 0.2 }))];
assert(buildTypingZoomSuggestions(moved, 10).length === 2, 'new field creates another zoom');
const fragment: ZoomFragment = { id: 'typing', start: 1.5, end: 4.4, mode: 'follow-cursor', followSource: 'typing', typingFocus: { x: 0.8, y: 0.8 }, targetScale: 1.65, easeIn: 0.5, easeOut: 0.5, damping: 4 };
const metadata: RecordingMetadata = { schemaVersion: 2, sourceWidth: 1920, sourceHeight: 1080,
  cursorSamples: [{ t: 0, x: 0.1, y: 0.1 }, { t: 10, x: 0.1, y: 0.1 }], cursorTypingSamples: typing };
const frames = computeZoomKeyframes(fragment, metadata, 30);
const middle = frames[Math.floor(frames.length/2)];
assert(middle.x > 0.6 && middle.y > 0.6, 'camera focuses typing field, not mouse on opposite side');
assert(metadata.cursorSamples[0].x === 0.1, 'real cursor track is unchanged');
assert(JSON.parse(JSON.stringify(fragment)).followSource === 'typing', 'typing zoom survives project save');
console.log('typingZoomSuggestions.selfcheck: ok');

const rapidSwitch = [...typing, ...[3.5,3.7,4,4.5].map(t => ({ t, x: 0.2, y: 0.2 }))];
const switched = buildTypingZoomSuggestions(rapidSwitch, 10);
assert(switched.some(s => s.focus.x < 0.3), 'rapid field switch is not hidden by previous hold');
assert(switched.length < 2 || switched[0].end <= switched[1].start, 'generated typing zooms never overlap');

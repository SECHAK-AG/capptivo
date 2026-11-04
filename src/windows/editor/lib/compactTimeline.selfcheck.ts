import { compactTimeline, sourceToTimeline, timelineToSource, projectTimelineRange } from './compactTimeline.ts';
function assert(value: boolean, message: string) { if (!value) throw new Error(message); }
const map = compactTimeline([{ id: 'a', start: 0, end: 3 }, { id: 'b', start: 7, end: 10 }], 10);
assert(map.duration === 6, 'deleted four seconds disappear from ruler');
assert(map.clips[0].timelineEnd === map.clips[1].timelineStart, 'kept clips meet directly');
assert(sourceToTimeline(map.clips, 8) === 4, 'zoom/caption/source action at eight seconds appears at four');
assert(timelineToSource(map.clips, 4) === 8, 'seeking output time returns matching source frame');
assert(timelineToSource(map.clips, 3) === 7, 'playhead at cut chooses next kept frame');
assert(timelineToSource(map.clips, 3, 'end') === 3, 'right edge at cut stays on preceding clip');
assert(projectTimelineRange(map.clips, 2, 8).duration === 2, 'overlay across cut contains only kept time');
assert(projectTimelineRange(map.clips, 4, 6).duration === 0, 'overlay wholly in deleted footage disappears');
for (const t of [0, 0.5, 2.9, 3, 4, 5.9, 6])
  assert(Math.abs(sourceToTimeline(map.clips, timelineToSource(map.clips, t))-t) < 1e-9, 'timeline/source roundtrip');
const restored = compactTimeline([{ id: 'all', start: 0, end: 10 }], 10);
assert(sourceToTimeline(restored.clips, 8) === 8, 'undo restores original positions without rewriting zoom metadata');
assert(compactTimeline([], 10).duration === 10, 'legacy empty layout retains full recording');
console.log('compactTimeline.selfcheck: ok');

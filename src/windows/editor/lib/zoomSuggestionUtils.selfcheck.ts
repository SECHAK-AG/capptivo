/** Exercise the production click-to-zoom implementation. */
import { buildClickZoomSuggestions } from './zoomSuggestionUtils.ts';

const assert = {
  equal(actual: unknown, expected: unknown) {
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
  },
  deepEqual(actual: unknown, expected: unknown) {
    this.equal(JSON.stringify(actual), JSON.stringify(expected));
  },
  ok(value: boolean) {
    if (!value) throw new Error('Assertion failed');
  },
};

const clicks = [
  { t: 1, x: 0.2, y: 0.3 },
  { t: 1.4, x: 0.21, y: 0.31 },
  { t: 8, x: 0.7, y: 0.6 },
];
const result = buildClickZoomSuggestions({ clicks, duration: 10 });
assert.equal(result.status, 'ok');
assert.equal(result.suggestions.length, 2);
assert.deepEqual(result.suggestions[0]?.focus, { x: 0.21, y: 0.31 });
assert.deepEqual(result.suggestions[1]?.focus, { x: 0.7, y: 0.6 });
for (const span of result.suggestions) {
  assert.ok(span.start >= 0 && span.end <= 10);
  assert.ok(span.end - span.start >= 1.2 - 1e-9);
}
assert.equal(buildClickZoomSuggestions({ clicks: [], duration: 10 }).status, 'no-clicks');
assert.equal(buildClickZoomSuggestions({ clicks, duration: 0 }).status, 'no-duration');
assert.equal(buildClickZoomSuggestions({
  clicks, duration: 10, reservedSpans: [{ start: 0, end: 10 }],
}).status, 'no-slots');
console.log('zoomSuggestionUtils.selfcheck: ok');

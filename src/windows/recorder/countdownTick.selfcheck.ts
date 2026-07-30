/**
 * Selfcheck: the countdown fires exactly once.
 *
 * Run: node --experimental-strip-types src/windows/recorder/countdownTick.selfcheck.ts
 */

import {
  initialCountdownState,
  markFired,
  shouldFire,
  tickCountdown,
} from "./countdownTick.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Counts down 3 → 2 → 1 → 0.
let s = initialCountdownState(3);
assert(s.n === 3, "starts at `from`");
assert(shouldFire(s) === false, "does not fire before reaching zero");
s = tickCountdown(s);
assert(s.n === 2, "3 → 2");
s = tickCountdown(s);
assert(s.n === 1, "2 → 1");
s = tickCountdown(s);
assert(s.n === 0, "1 → 0");

// At zero it wants to fire — exactly once.
assert(shouldFire(s) === true, "fires on reaching zero");
s = markFired(s);
assert(shouldFire(s) === false, "countdown must not fire twice");

// Extra ticks after zero change nothing and never re-arm the callback.
for (let i = 0; i < 5; i += 1) {
  s = tickCountdown(s);
  assert(s.n === 0, "never counts below zero");
  assert(shouldFire(s) === false, "a tick after completion must not re-arm");
}

// `markFired` is idempotent, and returns the same object once latched.
assert(markFired(markFired(s)).fired === true, "markFired is idempotent");
assert(markFired(s) === s, "markFired is a no-op once already fired");

// A zero/negative `from` fires immediately rather than counting down forever.
assert(shouldFire(initialCountdownState(0)) === true, "from=0 fires at once");
assert(initialCountdownState(-2).n === 0, "negative `from` clamps to zero");

// Fractional input floors rather than producing a non-integer badge.
assert(initialCountdownState(3.7).n === 3, "fractional `from` floors");

// A tick never mutates its input — the effect relies on identity changing.
const before = initialCountdownState(2);
const after = tickCountdown(before);
assert(before.n === 2, "tickCountdown does not mutate its argument");
assert(after !== before, "tickCountdown returns a new object");

console.log("countdownTick.selfcheck: ok");

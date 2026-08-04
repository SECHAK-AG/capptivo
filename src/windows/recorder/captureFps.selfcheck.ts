/** Selfcheck: capture frame-rate option parsing (pure — no localStorage). */

import {
  CAPTURE_FPS_OPTIONS,
  DEFAULT_CAPTURE_FPS,
  isCaptureFps,
  parseCaptureFps,
} from "./captureFps.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(
  CAPTURE_FPS_OPTIONS.includes(DEFAULT_CAPTURE_FPS),
  "the default must be one of the offered rates",
);
assert(
  CAPTURE_FPS_OPTIONS.every(isCaptureFps),
  "every offered rate must pass its own guard",
);

// Only rates a backend and encoder both handle. 24 and 120 are not offered, so
// they must not sneak in through a stale stored value.
for (const bad of [0, -30, 24, 29.97, 120, Number.NaN]) {
  assert(!isCaptureFps(bad), `${bad} is not a selectable capture rate`);
}

assert(parseCaptureFps("60") === 60, "a stored 60 round-trips");
assert(parseCaptureFps("30") === 30, "a stored 30 round-trips");

// A corrupt or absent preference must never reach the recorder as-is: a config
// with fps 0 would divide by zero in the pacer.
for (const bad of [null, "", "sixty", "0", "24", "1e9"]) {
  assert(
    parseCaptureFps(bad) === DEFAULT_CAPTURE_FPS,
    `${JSON.stringify(bad)} must fall back to the default`,
  );
}

console.log("captureFps.selfcheck: ok");

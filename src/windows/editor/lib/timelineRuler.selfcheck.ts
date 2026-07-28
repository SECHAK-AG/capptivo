/** Selfcheck: adaptive timeline ruler. */

import { buildTimelineRuler, formatTimelineTime } from "./timelineRuler.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(formatTimelineTime(65) === "01:05", "mm:ss");
assert(formatTimelineTime(3661) === "1:01:01", "h:mm:ss");
assert(formatTimelineTime(1.5, 1) === "00:01.5", "fractional");

// Zoomed-out 2min clip in ~800px → majors must be spaced, not every second.
{
  const ticks = buildTimelineRuler(120, 800 / 120);
  const majors = ticks.filter((t) => t.major);
  assert(majors.length >= 3 && majors.length <= 20, `zoomed-out majors=${majors.length}`);
  for (let i = 1; i < majors.length; i++) {
    const gapPx = (majors[i]!.time - majors[i - 1]!.time) * (800 / 120);
    assert(gapPx >= 70, `major gap ${gapPx}px too tight`);
  }
}

// Zoomed-in → sub-second majors appear.
{
  const ticks = buildTimelineRuler(10, 400);
  const majors = ticks.filter((t) => t.major);
  assert(majors.some((t) => (t.label ?? "").includes(".")), "sub-second labels when zoomed in");
  assert(ticks.some((t) => !t.major), "minors present when space allows");
}

console.log("timelineRuler.selfcheck: ok");

/**
 * Selfcheck: bar CSS-drag clamp (work-area overlay).
 *
 * Run: node --experimental-strip-types src/windows/recorder/barOffset.selfcheck.ts
 */

import { clampBarOffset } from "./barOffset.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const vp = { width: 1000, height: 800 };

assert(
  clampBarOffset({ x: 0, y: 0 }, { left: 100, top: 700, right: 500, bottom: 760 }, vp).x === 0,
  "in-bounds x unchanged",
);

assert(
  clampBarOffset({ x: -200, y: 0 }, { left: -50, top: 700, right: 350, bottom: 760 }, vp).x === -150,
  "pulls left edge on-screen",
);

assert(
  clampBarOffset({ x: 0, y: 100 }, { left: 100, top: 750, right: 500, bottom: 850 }, vp).y === 50,
  "pulls bottom edge on-screen",
);

console.log("barOffset.selfcheck: ok");

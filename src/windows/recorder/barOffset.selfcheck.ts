/**
 * Selfcheck: bar CSS-drag clamp (work-area overlay).
 *
 * Run: node --experimental-strip-types src/windows/recorder/barOffset.selfcheck.ts
 */

import { barTransform, clampBarOffset } from "./barOffset.ts";

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

assert(
  barTransform({ x: 0, y: 0 }) === "translate3d(calc(-50% + 0px), 0px, 0)",
  "zero offset transform",
);

assert(
  barTransform({ x: 12, y: -40 }) === "translate3d(calc(-50% + 12px), -40px, 0)",
  "nonzero offset transform",
);

assert(
  barTransform({ x: -8, y: 3 }) === "translate3d(calc(-50% + -8px), 3px, 0)",
  "negative x transform",
);

console.log("barOffset.selfcheck: ok");

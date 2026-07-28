/** Selfcheck: presentableVideoTime. */

import { FIRST_PRESENTABLE_TIME, presentableVideoTime } from "./presentableVideoTime.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(FIRST_PRESENTABLE_TIME === 0.001, "eps");
assert(presentableVideoTime(0, 32) === 0.001, "exact 0 parks at eps");
assert(presentableVideoTime(0.0004, 32) === 0.001, "near-0 parks at eps");
assert(presentableVideoTime(1.5, 32) === 1.5, "mid stays");
assert(presentableVideoTime(0, 0) === 0, "no duration passthrough");
assert(presentableVideoTime(0, 0.0005) === 0, "tiny duration can't park past end");

console.log("presentableVideoTime.selfcheck: ok");

/** Selfcheck: video zoom crop math. */

import { computeVideoZoomCrop } from "./videoZoomCrop.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const full = computeVideoZoomCrop(1920, 1080, 1, { x: 0.5, y: 0.5 });
assert(Math.abs(full.cropWidth - 1920) < 1e-6, "scale 1 → full width");
assert(Math.abs(full.sourceX) < 1e-6, "scale 1 centered → sourceX 0");

const zoom2 = computeVideoZoomCrop(1920, 1080, 2, { x: 0.5, y: 0.5 });
assert(Math.abs(zoom2.cropWidth - 960) < 1e-6, "2× zoom halves crop");
assert(Math.abs(zoom2.sourceX - 480) < 1e-6, "2× zoom centered crop");

const corner = computeVideoZoomCrop(100, 100, 2, { x: 0, y: 0 });
assert(Math.abs(corner.sourceX) < 1e-6, "corner zoom clamps sourceX");
assert(Math.abs(corner.sourceY) < 1e-6, "corner zoom clamps sourceY");

console.log("videoZoomCrop.selfcheck: ok");

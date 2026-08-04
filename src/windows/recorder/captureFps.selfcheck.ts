/** Selfcheck: fixed capture rates (pure). */

import {
  CAMERA_CAPTURE_FPS,
  SCREEN_CAPTURE_FPS,
} from "./captureFps.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(SCREEN_CAPTURE_FPS === 60, "screen capture is always 60");
assert(CAMERA_CAPTURE_FPS === 30, "face-cam is capped at 30");
assert(
  SCREEN_CAPTURE_FPS > CAMERA_CAPTURE_FPS,
  "screen outruns the webcam so export can downsample without inventing pixels",
);

console.log("captureFps.selfcheck: ok");

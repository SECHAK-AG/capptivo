/** Selfcheck: H.264 keyframe helpers (pure). */

import {
  ANNEX_B_CODEC,
  H264_KEYFRAME_INTERVAL_SEC,
  isAnnexBStartCode,
  isH264Keyframe,
} from "./h264Keyframe.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(ANNEX_B_CODEC.startsWith("avc1."), "annex-b codec is avc1");
assert(H264_KEYFRAME_INTERVAL_SEC === 4, "keyframe interval is 4s");

assert(isH264Keyframe(0, 30), "frame 0 is always a keyframe");
assert(isH264Keyframe(120, 30), "30fps → keyframe every 120 frames");
assert(!isH264Keyframe(1, 30), "frame 1 is not a keyframe at 30fps");
assert(!isH264Keyframe(119, 30), "frame 119 is not a keyframe at 30fps");
assert(isH264Keyframe(240, 60), "60fps → keyframe every 240 frames");
assert(!isH264Keyframe(239, 60), "frame 239 is not a keyframe at 60fps");
assert(isH264Keyframe(0, 1), "1fps still keyframes frame 0");
assert(isH264Keyframe(4, 1), "1fps keyframes every 4 frames");

assert(
  isAnnexBStartCode(new Uint8Array([0, 0, 0, 1, 0x65])),
  "4-byte start code is annex-b",
);
assert(
  isAnnexBStartCode(new Uint8Array([0, 0, 1, 0x65])),
  "3-byte start code is annex-b",
);
assert(
  !isAnnexBStartCode(new Uint8Array([0, 0, 0, 0x50, 0x65])),
  "length-prefixed avcC is not annex-b",
);

console.log("h264Keyframe.selfcheck: ok");

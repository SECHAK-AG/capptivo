/**
 * Runnable check for the "Original" export fast path. Run:
 *   node --experimental-strip-types src/windows/editor/export/passthrough.selfcheck.ts
 *
 * The failure this guards: the predicate goes lax and a stream-copy export
 * silently drops an edit (a cut, a zoom, the face-cam) — the user only finds
 * out after sharing the video. Every case below is a state where the answer
 * must be NO, plus the bare states where the fast path is honestly lossless.
 */

import { isPassthroughEligible, type PassthroughCheck } from "./passthrough.ts";

export {}; // module scope

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const CLEAN: PassthroughCheck = {
  segments: [],
  duration: 60,
  zoomFragments: [],
  blurRegions: [],
  captions: [],
  cameraUrl: null,
  screenContentCrop: null,
};

// Lossless states.
assert(isPassthroughEligible(CLEAN), "a fresh recording must be eligible");
assert(
  isPassthroughEligible({
    ...CLEAN,
    segments: [{ id: "seg-1", start: 0, end: 60 }],
  }),
  "a single full-range segment is not a cut",
);

// Cuts: anything that removes timeline content snaps to keyframes under copy.
assert(
  !isPassthroughEligible({
    ...CLEAN,
    segments: [{ id: "seg-1", start: 5, end: 60 }],
  }),
  "a trimmed start must force the full render",
);
assert(
  !isPassthroughEligible({
    ...CLEAN,
    segments: [
      { id: "seg-1", start: 0, end: 20 },
      { id: "seg-2", start: 25, end: 60 },
    ],
  }),
  "a middle cut must force the full render",
);

// Overlays and pixel changes vanish from a stream copy.
assert(
  !isPassthroughEligible({ ...CLEAN, zoomFragments: [{}] }),
  "zooms must force the full render",
);
assert(
  !isPassthroughEligible({ ...CLEAN, blurRegions: [{}] }),
  "blurs must force the full render",
);
assert(
  !isPassthroughEligible({ ...CLEAN, captions: [{}] }),
  "captions must force the full render",
);
assert(
  !isPassthroughEligible({ ...CLEAN, cameraUrl: "media://x/camera.mp4" }),
  "a face-cam track must force the full render",
);
assert(
  !isPassthroughEligible({ ...CLEAN, screenContentCrop: { x: 0, y: 0 } }),
  "a content crop must force the full render",
);

console.log("passthrough.selfcheck: ok");

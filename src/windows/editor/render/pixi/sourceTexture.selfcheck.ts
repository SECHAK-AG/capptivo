/** Selfcheck: GPU texture upload elision. */

import {
  immutableFrameNeedsUpload,
  needsGpuUpload,
  SourceTexture,
} from "./sourceTexture.ts";
import { videoStampNeedsUpload } from "../videoFrameTrack.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const frameA = { tag: "a" };
const frameB = { tag: "b" };

// Immutable frame rule (VideoFrame path in the browser).
assert(immutableFrameNeedsUpload(null, frameA) === true, "first bind uploads");
assert(
  immutableFrameNeedsUpload(frameA, frameA) === false,
  "identical frame skips",
);
assert(
  immutableFrameNeedsUpload(frameA, frameB) === true,
  "different frame uploads",
);

// Elements/canvases mutate in place — always upload even when the ref matches.
const canvas = { width: 1, height: 1 } as unknown as HTMLCanvasElement;
assert(needsGpuUpload(canvas, canvas) === true, "canvas always uploads");
assert(needsGpuUpload(null, canvas) === true, "canvas first bind uploads");

// Preview <video> stamp gate (RVFC + seek generation).
assert(
  videoStampNeedsUpload(null, null) === true,
  "untracked video always uploads",
);
assert(
  videoStampNeedsUpload(null, { presentedFrames: null, generation: 0 }) ===
    true,
  "first tracked bind uploads",
);
// Safe only because SourceTexture.rememberBound refuses to record a stamp for
// an upload that had no decoded pixels — otherwise this skip would freeze the
// empty first upload onto the stage.
assert(
  videoStampNeedsUpload(
    { presentedFrames: null, generation: 0 },
    { presentedFrames: null, generation: 0 },
  ) === false,
  "waiting on RVFC skips re-upload",
);
// The blank-first-upload case: no recorded stamp means upload again, which is
// what un-freezes the screen layer once pixels actually decode.
assert(
  videoStampNeedsUpload(null, { presentedFrames: null, generation: 0 }) ===
    true,
  "an upload with no decoded pixels re-uploads next bind",
);
assert(
  videoStampNeedsUpload(
    { presentedFrames: null, generation: 0 },
    { presentedFrames: 3, generation: 0 },
  ) === true,
  "first presented frame uploads",
);
assert(
  videoStampNeedsUpload(
    { presentedFrames: 3, generation: 0 },
    { presentedFrames: 3, generation: 0 },
  ) === false,
  "identical presented frame skips",
);
assert(
  videoStampNeedsUpload(
    { presentedFrames: 3, generation: 0 },
    { presentedFrames: 4, generation: 0 },
  ) === true,
  "new presented frame uploads",
);
assert(
  videoStampNeedsUpload(
    { presentedFrames: 3, generation: 0 },
    { presentedFrames: 3, generation: 1 },
  ) === true,
  "seek generation forces upload",
);
assert(
  videoStampNeedsUpload(
    { presentedFrames: 3, generation: 0 },
    { presentedFrames: null, generation: 1 },
  ) === true,
  "seek clearing presented frames uploads",
);

// --- teardown must not touch the caller's <video> ---------------------------
// The bug this guards: Pixi's VideoSource.destroy() pauses the element, sets
// `src = ""` and calls load(). The preview <video> is owned by React, so a
// compositor remount (the crash-recovery path) would fire
// MEDIA_ERR_SRC_NOT_SUPPORTED on it and black the stage for good — React never
// re-assigns an unchanged `src` prop.
class FakeVideoElement {
  src = "blob:selfcheck";
  paused = true;
  ended = false;
  videoWidth = 640;
  videoHeight = 360;
  readyState = 2;
  loadCalls = 0;
  pauseCalls = 0;
  load(): void {
    this.loadCalls += 1;
  }
  pause(): void {
    this.pauseCalls += 1;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  requestVideoFrameCallback(): number {
    return 0;
  }
  cancelVideoFrameCallback(): void {}
}
// `isVideoElement` is an instanceof check; give it something to match on.
(globalThis as { HTMLVideoElement?: unknown }).HTMLVideoElement =
  FakeVideoElement;

const element = new FakeVideoElement();
const texture = new SourceTexture("screen", 1920);
assert(
  texture.bind(element as unknown as HTMLVideoElement) !== null,
  "video element binds",
);
texture.destroy();
assert(element.src === "blob:selfcheck", "destroy leaves the element's src");
assert(element.loadCalls === 0, "destroy does not re-load the element");
assert(element.pauseCalls === 0, "destroy does not pause the element");

console.log("sourceTexture.selfcheck: ok");

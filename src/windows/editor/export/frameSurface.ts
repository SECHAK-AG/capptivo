/**
 * A stand-in for `HTMLVideoElement` holding the frame the export loop is
 * currently on.
 *
 * WebCodecs already hands us a `VideoFrame` that Pixi can upload directly
 * (WebGL `texImage2D` / WebGPU `copyExternalImageToTexture`), so the default
 * path keeps that frame and skips painting into a canvas. Painting only
 * happens when `toVideoFrame()` can't express rotation metadata — rotated
 * phone-camera sources fall back to `sample.draw()` onto a canvas.
 *
 * On WebKit this matters twice over: Pixi force-reallocates the texture on
 * every upload from an `HTMLVideoElement` (a Safari workaround), while an
 * `ImageSource` fed a `VideoFrame` takes the cheap `texSubImage2D` path.
 *
 * VFR screen recordings emit the same source sample for many output ticks. When
 * a push repeats the previous sample timestamp, the held `VideoFrame` is kept
 * (same object identity) so the GPU compositor can skip the texture upload.
 */

import type { VideoSample } from "mediabunny";

import {
  registerDecodedFrameSource,
  unregisterDecodedFrameSource,
  type DecodedImage,
} from "../render/decodedFrame";

export type FrameSurfaceMode = "canvas" | "video-frame";

export type FrameSurface = {
  /** The `HTMLVideoElement`-shaped object the compositor is handed. */
  element: HTMLVideoElement;
  /** Adopt the next decoded sample, releasing the previous one. */
  push: (sample: VideoSample) => void;
  /**
   * Prefer `VideoFrame` upload vs canvas paint. Callers set this once at
   * `begin()`; switching mid-run is safe.
   */
  setMode: (mode: FrameSurfaceMode) => void;
  dispose: () => void;
};

export function createFrameSurface(duration: number): FrameSurface {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not create frame surface context");

  let mode: FrameSurfaceMode = "video-frame";
  // HAVE_NOTHING until the first decoded frame lands — the render path skips
  // drawing, the same guard it applies to a not-yet-seeked element.
  let readyState = 0;
  let width = 0;
  let height = 0;
  // Held so the GPU can upload from them; both are released on the next
  // *distinct* push (same sample timestamp reuses them).
  let sample: VideoSample | null = null;
  let frame: VideoFrame | null = null;
  let heldTimestamp = Number.NaN;

  Object.defineProperties(canvas, {
    videoWidth: { get: () => width },
    videoHeight: { get: () => height },
    readyState: { get: () => readyState },
    duration: { get: () => duration },
  });

  // Structural stand-in: it satisfies everything the render path reads, and
  // `drawImage()` accepts it because it genuinely is a canvas.
  const element = canvas as unknown as HTMLVideoElement;

  const release = () => {
    frame?.close();
    frame = null;
    sample?.close();
    sample = null;
    heldTimestamp = Number.NaN;
  };

  const push = (next: VideoSample) => {
    const w = next.displayWidth;
    const h = next.displayHeight;
    if (w <= 0 || h <= 0) {
      next.close();
      return;
    }

    // `toVideoFrame()` cannot express rotation metadata, so rotated sources
    // (phone cameras) fall back to the canvas, where `draw()` applies it.
    const canUseVideoFrame =
      mode === "video-frame" && next.rotation === 0 && typeof VideoFrame !== "undefined";

    // Same source sample as last push (VFR screen at higher output fps): keep
    // the held VideoFrame so GPU upload elision sees identical identity.
    if (
      canUseVideoFrame &&
      frame !== null &&
      sample !== null &&
      next.timestamp === heldTimestamp
    ) {
      next.close();
      return;
    }

    release();
    width = w;
    height = h;

    if (canUseVideoFrame) {
      sample = next;
      frame = next.toVideoFrame();
      heldTimestamp = next.timestamp;
    } else {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      next.draw(ctx, 0, 0);
      next.close();
      heldTimestamp = next.timestamp;
    }
    readyState = 4; // HAVE_ENOUGH_DATA
  };

  registerDecodedFrameSource(element, (): DecodedImage | null => {
    if (frame) return frame;
    return readyState > 0 ? canvas : null;
  });

  return {
    element,
    push,
    setMode: (next) => {
      mode = next;
    },
    dispose: () => {
      release();
      unregisterDecodedFrameSource(element);
      canvas.width = 0;
      canvas.height = 0;
      readyState = 0;
    },
  };
}

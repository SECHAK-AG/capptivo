/**
 * Shared export compositor. Decoded pixels come from a `CompositorMedia` pair:
 * either sequential frame surfaces (`sequentialMedia.ts`, the fast path) or
 * blob-URL-backed `<video>` elements (`loadElementMedia`, the seek fallback —
 * same-origin `blob:` via `mediaBlobUrl.ts` because `media://` is rejected by
 * WebGL/WebGPU texture upload on WKWebView even with CORS headers).
 *
 * Frame pixels are produced by the shared Pixi `FrameCompositor` so preview
 * and export stay WYSIWYG.
 */

import {
  computeCursorLoopReturn,
  createFullSegment,
  resolveZoomPanAtTime,
  totalKeptDuration,
  type TrimSegment,
} from "@/engine";
import { getZoomKeyframesMap } from "../lib/zoomCache";
import { resolveZoomReactiveState } from "../render/renderFrame";
import {
  createFrameCompositor,
  type FrameCompositor,
  type FrameCompositorSurface,
} from "../render/createFrameCompositor";
import { toBlobMediaUrl } from "../lib/mediaBlobUrl";
import { useEditorStore } from "../store";

export type ExportCompositor = {
  /** Output-sized bitmap: what the encoder captures. */
  canvas: FrameCompositorSurface;
  /** Present when `cpuReadback` was requested (GIF). */
  ctx: CanvasRenderingContext2D | null;
  /** Which compositor won — decode strategy tunes itself off this. */
  backend: FrameCompositor["backend"];
  video: HTMLVideoElement;
  camera: HTMLVideoElement | null;
  segments: TrimSegment[];
  kept: number;
  width: number;
  height: number;
  drawAt: (sourceTime: number) => void;
  /** Per-phase compose timings for the export log. */
  stats: () => string | null;
  /** GPU upload elision counts when the Pixi backend is active. */
  uploadStats: () => { uploads: number; skipped: number } | null;
  dispose: () => void;
};

/**
 * The decoded-pixel providers the compositor draws from. Either real
 * `<video>` elements (legacy seek path, `loadElementMedia`) or sequential
 * frame surfaces (`sequentialMedia.ts`) — `drawAt` is agnostic.
 */
export type CompositorMedia = {
  video: HTMLVideoElement;
  camera: HTMLVideoElement | null;
  /** Screen duration in seconds (drives full-segment + cursor-loop math). */
  duration: number;
  dispose: () => void;
};

export type CompositorOptions = {
  /**
   * Keep the output canvas CPU-resident for `getImageData` (GIF quantization).
   * MP4/WebM never read pixels back — leaving this off keeps compositing and
   * the encoder hand-off on the GPU (export-performance-audit.md §3).
   */
  cpuReadback?: boolean;
  /**
   * Set false to force a DOM-backed canvas. Only the MediaRecorder fallback
   * needs this — it calls `captureStream()`, which an OffscreenCanvas has not.
   */
  offscreen?: boolean;
};

/**
 * Long edge the preview stage composites at (see `computeStageDimensionsForVideo`).
 * The look values the user tunes — face-cam size, device padding, corner radius,
 * caption font size — are absolute pixels calibrated against this resolution, so
 * the export MUST composite at the same reference and downscale, or those sizes
 * would balloon on a smaller output canvas (e.g. an 800px GIF).
 */
const COMPOSITION_REFERENCE_LONG_EDGE = 1920;

async function loadVideo(src: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  // Blob URLs are same-origin; leave crossOrigin unset to avoid CORS mode quirks.
  video.src = src;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await once(video, "loadedmetadata");
  return video;
}

/** Load screen (+ camera) as blob-backed `<video>` elements — the legacy
 * decode path, still used by the seek-based fallback and MediaRecorder. */
export async function loadElementMedia(
  screenUrl: string,
  cameraUrl: string | null,
): Promise<CompositorMedia> {
  const screenBlob = await toBlobMediaUrl(screenUrl);
  const cameraBlob = cameraUrl ? await toBlobMediaUrl(cameraUrl).catch(() => null) : null;

  const video = await loadVideo(screenBlob.src);
  const seekableEnd = video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : 0;
  console.info(
    `[export] screen <video> loaded: duration=${video.duration.toFixed(3)}s ` +
      `seekable=[0..${seekableEnd.toFixed(3)}] readyState=${video.readyState} ` +
      `videoWidth=${video.videoWidth}x${video.videoHeight}`,
  );
  let camera: HTMLVideoElement | null = null;
  if (cameraBlob) {
    camera = await loadVideo(cameraBlob.src).catch(() => null);
  }

  return {
    video,
    camera,
    duration: video.duration || 0,
    dispose: () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      if (camera) {
        camera.pause();
        camera.removeAttribute("src");
        camera.load();
      }
      screenBlob.revoke();
      cameraBlob?.revoke();
    },
  };
}

export async function createExportCompositor(
  screenUrl: string,
  cameraUrl: string | null,
  width: number,
  height: number,
  options: CompositorOptions = {},
): Promise<ExportCompositor> {
  return createExportCompositorFromMedia(
    await loadElementMedia(screenUrl, cameraUrl),
    width,
    height,
    options,
  );
}

export async function createExportCompositorFromMedia(
  media: CompositorMedia,
  width: number,
  height: number,
  options: CompositorOptions = {},
): Promise<ExportCompositor> {
  // Composite at the preview's reference resolution and let the compositor
  // downscale to the output. Keeps look values (face-cam, padding, captions)
  // calibrated at the same absolute pixels as the preview — and on the GPU
  // path the downscale never leaves the GPU.
  const longEdge = Math.max(width, height);
  const superscale =
    longEdge >= COMPOSITION_REFERENCE_LONG_EDGE
      ? 1
      : COMPOSITION_REFERENCE_LONG_EDGE / longEdge;
  const renderWidth = Math.max(2, Math.round(width * superscale));
  const renderHeight = Math.max(2, Math.round(height * superscale));

  let frame: FrameCompositor;
  try {
    frame = await createFrameCompositor({
      width: renderWidth,
      height: renderHeight,
      outputWidth: width,
      outputHeight: height,
      cpuReadback: options.cpuReadback,
      // The encoder captures the canvas after `compose()` returns.
      preserveDrawingBuffer: true,
      // Export runs flat out; it must not be paced by the display refresh.
      offscreen: options.offscreen !== false,
      // Silent DOM fallback would cap export at ~display refresh — fail loud.
      requireOffscreen: options.offscreen !== false,
      // Fixed output size: MSAA + per-upload mipmap regen are pure cost.
      antialias: false,
      mipmaps: false,
      profile: true,
    });
  } catch (e) {
    media.dispose();
    throw e;
  }

  const { video, camera } = media;

  const store = useEditorStore.getState();
  const segments: TrimSegment[] =
    store.segments.length > 0
      ? store.segments
      : createFullSegment(media.duration);
  const kept = totalKeptDuration(segments);
  if (kept <= 0) {
    frame.dispose();
    media.dispose();
    throw new Error("nothing to export — all content is trimmed");
  }

  const drawAt = (sourceTime: number) => {
    const {
      sourceAspect,
      backgroundImage,
      look,
      zoomFragments,
      recordingMetadata,
      screenContentCrop,
      cursorSettings,
      faceCam,
      captions,
      captionSettings,
      aspectRatioPresetId,
      backgroundType,
      sourceVideoSize,
    } = useEditorStore.getState();

    const keyframes = getZoomKeyframesMap(zoomFragments, recordingMetadata, screenContentCrop);
    const zoom = resolveZoomPanAtTime(zoomFragments, recordingMetadata, sourceTime, keyframes);
    const active = zoomFragments.find((f) => sourceTime >= f.start && sourceTime <= f.end) ?? null;

    frame.compose(
      {
        width: renderWidth,
        height: renderHeight,
        video,
        cameraVideo: camera,
        sourceAspect,
        background: backgroundImage,
        look,
        aspectRatioPresetId,
        backgroundType,
        sourceVideoSize,
        // Baked keyframes go straight to the camera: they are already
        // recording-rect NDC, enveloped and clamped.
        zoomScale: zoom.scale,
        zoomFocus: { x: zoom.x, y: zoom.y },
        ...resolveZoomReactiveState(active, sourceTime),
        screenContentCrop,
        cursorTime: sourceTime,
        cursorSettings,
        cursorLoopReturn: cursorSettings.loopCursor
          ? computeCursorLoopReturn(segments, media.duration)
          : null,
        recordingMetadata,
        faceCam,
      },
      {
        captions,
        settings: captionSettings,
        timeMs: sourceTime * 1000,
      },
    );
  };

  return {
    canvas: frame.canvas,
    ctx: frame.readback,
    backend: frame.backend,
    stats: () => frame.stats(),
    uploadStats: () => frame.uploadStats(),
    video,
    camera,
    segments,
    kept,
    width,
    height,
    drawAt,
    dispose: () => {
      frame.dispose();
      media.dispose();
    },
  };
}

/**
 * The deterministic frame clock: one source timestamp per output frame, in
 * ascending order across the kept segments. Both export paths (sequential
 * decode and per-frame seeks) and both formats (MP4/WebM and GIF) sample the
 * source at exactly these times, so frame selection — and therefore output —
 * is identical regardless of decode strategy.
 *
 * Samples the **center** of each 1/fps slot (not the leading edge). Exact
 * `t=0` often has no decodable sample yet on fMP4 / WebCodecs (`null` → blank
 * surface → black export with only the cursor). Mid-slot matches what a
 * primed `<video>` seek tends to paint for the first frame.
 */
export function planFrameTimes(segments: TrimSegment[], fps: number): number[] {
  const times: number[] = [];
  const slot = 1 / Math.max(1, fps);
  for (const seg of segments) {
    const duration = Math.max(0, seg.end - seg.start);
    const frameCount = Math.max(1, Math.round(duration * fps));
    for (let i = 0; i < frameCount; i++) {
      times.push(Math.min(seg.end - 1e-4, seg.start + (i + 0.5) * slot));
    }
  }
  return times;
}

export function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.001) {
      resolve();
      return;
    }
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("seek failed"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onErr, { once: true });
    video.currentTime = time;
  });
}

export function waitUntil(video: HTMLVideoElement, pred: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (pred()) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function once(
  target: HTMLMediaElement,
  event: "loadedmetadata" | "ended",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`video failed before "${event}"`));
    };
    const cleanup = () => {
      target.removeEventListener(event, onOk);
      target.removeEventListener("error", onErr);
    };
    target.addEventListener(event, onOk, { once: true });
    target.addEventListener("error", onErr, { once: true });
  });
}

/** Yield so the UI can paint progress during long GIF encodes. */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

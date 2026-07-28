/**
 * Shared export compositor. Decoded pixels from `CompositorMedia` (sequential
 * surfaces or blob-backed `<video>`). Preview and export share `FrameCompositor`.
 */

import {
  computeCursorLoopReturn,
  createFullSegment,
  totalKeptDuration,
  type TrimSegment,
} from "@/engine";
import { getZoomPanAtTime } from "../lib/zoomCache";
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
  /** CPU-resident canvas for `getImageData` (GIF). */
  cpuReadback?: boolean;
  /** Force DOM canvas — MediaRecorder needs `captureStream()`. */
  offscreen?: boolean;
};

/** Preview reference long edge — look values are calibrated at this resolution. */
const COMPOSITION_REFERENCE_LONG_EDGE = 1920;

async function loadVideo(src: string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.src = src;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await once(video, "loadedmetadata");
  return video;
}

/** Blob-backed `<video>` elements — seek fallback and MediaRecorder path. */
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
      preserveDrawingBuffer: true,
      offscreen: options.offscreen !== false,
      requireOffscreen: options.offscreen !== false,
      antialias: false,
      mipmaps: false,
      profile: true,
    });
  } catch (e) {
    media.dispose();
    throw e;
  }

  const { video, camera } = media;

  // Pin editor state at export start — mid-export edits must not land in the file.
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
    segments: storeSegments,
  } = useEditorStore.getState();

  const segments: TrimSegment[] =
    storeSegments.length > 0 ? storeSegments : createFullSegment(media.duration);
  const kept = totalKeptDuration(segments);
  if (kept <= 0) {
    frame.dispose();
    media.dispose();
    throw new Error("nothing to export — all content is trimmed");
  }

  const cursorLoopReturn = cursorSettings.loopCursor
    ? computeCursorLoopReturn(segments, media.duration)
    : null;

  const drawAt = (sourceTime: number) => {
    const zoom = getZoomPanAtTime(
      zoomFragments,
      recordingMetadata,
      screenContentCrop,
      sourceTime,
    );
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
        zoomScale: zoom.scale,
        zoomFocus: { x: zoom.x, y: zoom.y },
        ...resolveZoomReactiveState(active, sourceTime),
        screenContentCrop,
        cursorTime: sourceTime,
        cursorSettings,
        cursorLoopReturn,
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
 * Deterministic frame clock: one source timestamp per output frame.
 * Samples the center of each 1/fps slot (avoids blank first frame on fMP4).
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

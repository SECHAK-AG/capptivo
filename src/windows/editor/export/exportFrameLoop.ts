/**
 * Shared export frame loop — pipelined decode overlapping composite/encode.
 *
 * Recordly and Cap both hide decode latency behind the next stage; this module
 * is the WebView equivalent while keeping the Pixi compositor WYSIWYG. Every
 * MP4/WebM/GIF route should iterate through here instead of hand-rolling
 * `await reader.nextFrame(); drawAt(t)`.
 */

import { faceCamMediaTime, type FaceCamTrack } from "../lib/faceCamSync.ts";
import { seekTo } from "./exportSeek.ts";
import { ExportCancelledError } from "./exportCancel.ts";
import type { SequentialReader } from "./sequentialMedia";

/** How many samples mediabunny prefetches per track (see sequentialMedia.ts). */
export const SEQUENTIAL_PREFETCH_DEPTH = 8;

export type ExportFrameIterator = {
  readonly mode: "sequential" | "seek";
  readonly count: number;
  /** Source time (seconds) for output frame `index`. */
  timeAt: (index: number) => number;
  /**
   * Prime decode for frame 0. Must run once before the first `advance()`.
   * Cheap no-op on the seek path (first seek happens inside advance).
   */
  prime: () => Promise<void>;
  /**
   * Advance to frame `index` (0-based). Overlaps decode of frame `index+1`
   * with the caller's composite/encode work on frame `index`.
   */
  advance: (index: number) => Promise<void>;
  dispose: () => void;
};

type SeekSource = {
  video: HTMLVideoElement;
  camera: HTMLVideoElement | null;
  faceCam: FaceCamTrack;
};

export function createExportFrameIterator(
  frameTimes: number[],
  reader: SequentialReader | null,
  seek: SeekSource | null,
  options?: { maxDriftLogs?: number; signal?: AbortSignal },
): ExportFrameIterator {
  const maxDriftLogs = options?.maxDriftLogs ?? 10;
  let driftLogs = 0;
  /** Decode task for the *next* frame — overlaps with composite on the current one. */
  let pendingDecode: Promise<void> | null = null;
  let disposed = false;
  const disposeController = new AbortController();
  const externalAbort = options?.signal;
  const onExternalAbort = () => disposeController.abort();
  externalAbort?.addEventListener("abort", onExternalAbort, { once: true });

  const seekOne = async (t: number): Promise<void> => {
    if (!seek) return;
    if (disposed) throw new ExportCancelledError();
    await seekTo(seek.video, t, { signal: disposeController.signal });
    if (seek.camera) {
      const camT = faceCamMediaTime(
        t,
        seek.faceCam.offsetMs,
        seek.camera.duration,
      );
      if (camT != null) {
        await seekTo(seek.camera, camT, { signal: disposeController.signal }).catch((error) => {
          if (error instanceof ExportCancelledError || disposeController.signal.aborted) {
            throw error;
          }
        });
      }
    }
    if (
      Math.abs(seek.video.currentTime - t) > 0.1 &&
      driftLogs < maxDriftLogs
    ) {
      driftLogs += 1;
      console.warn(
        `[export] seek clamp at ${t.toFixed(3)}s ` +
          `got ${seek.video.currentTime.toFixed(3)}s`,
      );
    }
  };

  const startDecode = (index: number): Promise<void> | null => {
    if (index >= frameTimes.length) return null;
    const t = frameTimes[index]!;
    if (reader) return reader.nextFrame();
    return seekOne(t);
  };

  return {
    mode: reader ? "sequential" : "seek",
    count: frameTimes.length,
    timeAt: (index) => frameTimes[index] ?? 0,
    prime: async () => {
      if (reader) {
        await startDecode(0);
        return;
      }
      // Seek mode is deliberately not pipelined. One HTMLVideoElement has one
      // mutable currentTime; starting the next seek here can replace the frame
      // the compositor is about to consume.
    },
    advance: async (index: number) => {
      if (reader) {
        if (index > 0) {
          if (pendingDecode) await pendingDecode;
        }
        pendingDecode = startDecode(index + 1);
        return;
      }
      await seekOne(frameTimes[index]!);
    },
    dispose: () => {
      disposed = true;
      disposeController.abort();
      externalAbort?.removeEventListener("abort", onExternalAbort);
      reader?.dispose?.();
      pendingDecode = null;
    },
  };
}

/** Loud warning when the per-frame seek path is selected — the #1 export slowdown. */
export function warnSeekPath(route: string, frameCount: number): void {
  console.warn(
    `[export] ${route} is seeking per frame for all ${frameCount} frames — ` +
      `expect an export far slower than realtime; check errors.log for decode-fallback`,
  );
}

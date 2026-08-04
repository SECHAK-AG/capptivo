/**
 * Path B MP4 export: Pixi compose → RGBA readback → Rust ffmpeg encode.
 *
 * Same compositor as preview/GIF (WYSIWYG). Encode uses the probed hardware
 * encoder outside WebView2 — the Windows-reliable escape hatch.
 */

import { commands } from "../../../ipc/bindings";
import { faceCamMediaTime, type FaceCamTrack } from "../lib/faceCamSync";
import {
  createExportCompositor,
  createExportCompositorFromMedia,
  planFrameTimes,
  seekTo,
} from "./exportCompositor";
import { openSequentialMedia } from "./sequentialMedia";
import { shouldYieldNow, yieldToMain } from "./exportYield";
import { throwIfAborted } from "./exportCancel";
import type { ResolvedExportParams } from "./exportSettings";
import { GpuContextLostError } from "../render/gpuLifecycle";
import { useEditorStore } from "../store";
import { describeError } from "../../recorder/store";

/** Cap in-flight IPC frames so compose does not outrun the ffmpeg pipe. */
const MAX_PENDING_WRITES = 2;

function throwIfGpuLost(isLost: () => boolean): void {
  if (isLost()) throw new GpuContextLostError();
}

/**
 * Compose + CPU readback → ffmpeg H.264 encode at `path`.
 * Audio is attached afterward by the caller.
 */
export async function renderMp4ViaFfmpegRawvideo(
  path: string,
  screenUrl: string,
  faceCam: FaceCamTrack,
  params: ResolvedExportParams,
  signal: AbortSignal,
): Promise<void> {
  const { width, height, fps, bitrate } = params;
  throwIfAborted(signal);

  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(
      `rawvideo export requires even dimensions (got ${width}x${height})`,
    );
  }

  const handle = await commands.beginExportRawvideoStream({
    path,
    width,
    height,
    fps,
    bitrate,
  });
  let settled = false;
  const abortMux = async (reason: string) => {
    if (settled) return;
    settled = true;
    await commands
      .abortExportRawvideoStream(handle, reason)
      .catch(() => undefined);
  };

  // Same cpuReadback surface as GIF — getImageData after each compose.
  const sequential = await openSequentialMedia(screenUrl, faceCam).catch(
    () => null,
  );
  const session = sequential
    ? await createExportCompositorFromMedia(sequential.media, width, height, {
        cpuReadback: true,
      })
    : await createExportCompositor(screenUrl, faceCam, width, height, {
        cpuReadback: true,
      });
  const {
    ctx,
    video,
    camera,
    segments,
    drawAt,
    dispose,
    backend,
    stats,
    uploadStats,
    isGpuLost,
  } = session;

  if (!ctx) {
    dispose();
    await abortMux("rawvideo export requires a readable canvas");
    throw new Error("rawvideo export requires a readable canvas");
  }

  let writeChain: Promise<void> = Promise.resolve();
  let writeError: Error | null = null;
  let pendingWrites = 0;
  let framesEncoded = 0;

  const fail = (e: unknown) => {
    if (!writeError) writeError = new Error(describeError(e));
  };

  const enqueueFrame = (pixels: Uint8ClampedArray) => {
    // Copy — the next getImageData reuses compositor backing stores.
    const buf = new Uint8Array(pixels);
    pendingWrites += 1;
    writeChain = writeChain
      .then(async () => {
        if (writeError || signal.aborted) return;
        await commands.writeExportRawvideoFrame(handle, buf);
      })
      .catch(fail)
      .finally(() => {
        pendingWrites = Math.max(0, pendingWrites - 1);
      });
  };

  try {
    const frameTimes = planFrameTimes(segments, fps);
    const reader =
      sequential?.begin(frameTimes, { mode: "video-frame" }) ?? null;
    const progress = throttledProgress(frameTimes.length);
    const expectedBytes = width * height * 4;

    console.info(
      `[export] ffmpeg-rawvideo: path=${reader ? "sequential" : "seek"} ` +
        `compositor=${backend} frames=${frameTimes.length} ` +
        `${width}x${height}@${fps}`,
    );

    let lastYieldAt = performance.now();
    let driftLogs = 0;
    let yields = 0;
    let yieldMs = 0;
    const loopStart = performance.now();

    for (const t of frameTimes) {
      throwIfAborted(signal);
      if (writeError) throw writeError;
      throwIfGpuLost(isGpuLost);

      if (reader) {
        await reader.nextFrame();
      } else {
        await seekTo(video, t);
        if (camera) {
          const camT = faceCamMediaTime(t, faceCam.offsetMs, camera.duration);
          if (camT != null) await seekTo(camera, camT).catch(() => undefined);
        }
        if (Math.abs(video.currentTime - t) > 0.1 && driftLogs < 10) {
          driftLogs += 1;
          console.warn(
            `[export] ffmpeg-rawvideo seek clamp: wanted ${t.toFixed(3)}s ` +
              `got ${video.currentTime.toFixed(3)}s`,
          );
        }
      }

      throwIfGpuLost(isGpuLost);
      drawAt(t);
      throwIfGpuLost(isGpuLost);

      const image = ctx.getImageData(0, 0, width, height);
      if (image.data.byteLength !== expectedBytes) {
        throw new Error(
          `rawvideo readback size mismatch: got ${image.data.byteLength}, expected ${expectedBytes}`,
        );
      }

      while (pendingWrites >= MAX_PENDING_WRITES) {
        await writeChain.catch(() => undefined);
        if (writeError) throw writeError;
        throwIfAborted(signal);
        if (pendingWrites >= MAX_PENDING_WRITES) await yieldToMain();
      }

      enqueueFrame(image.data);
      framesEncoded += 1;
      progress(framesEncoded);

      const decision = shouldYieldNow(performance.now(), lastYieldAt);
      if (decision.shouldYield) {
        yields += 1;
        const yieldStart = performance.now();
        await yieldToMain();
        lastYieldAt = performance.now();
        yieldMs += lastYieldAt - yieldStart;
        throwIfAborted(signal);
      }
    }

    await writeChain;
    if (writeError) throw writeError;
    if (framesEncoded === 0) {
      throw new Error("ffmpeg rawvideo export produced no frames");
    }

    const wallMs = performance.now() - loopStart;
    const uploads = uploadStats();
    console.info(
      `[export] ffmpeg-rawvideo done in ${(wallMs / 1000).toFixed(1)}s ` +
        `(${(framesEncoded / (wallMs / 1000)).toFixed(1)} fps) — ` +
        `yields=${yields} yieldMs=${yieldMs.toFixed(0)}` +
        (uploads
          ? ` uploads=${uploads.uploads} skipped=${uploads.skipped}`
          : ""),
    );
    const breakdown = stats();
    if (breakdown) console.info(`[export] composite breakdown: ${breakdown}`);

    settled = true;
    await commands.finishExportRawvideoStream(handle);
  } catch (e) {
    const reason = describeError(e);
    console.error(`[export] ffmpeg-rawvideo failed: ${reason}`);
    await abortMux(reason);
    throw e instanceof Error ? e : new Error(reason);
  } finally {
    dispose();
    if (!settled) {
      await abortMux("export failed");
    }
  }
}

function throttledProgress(total: number): (done: number) => void {
  let lastPercent = -1;
  return (done: number) => {
    const ratio = Math.min(1, done / Math.max(1, total));
    const percent = Math.round(ratio * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    useEditorStore.getState().setExportProgress(ratio);
  };
}

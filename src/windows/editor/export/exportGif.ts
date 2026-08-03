/**
 * Frame-accurate GIF encode (gifenc). Requires an untainted canvas — the
 * sequential path decodes via WebCodecs (never taints); the fallback loads
 * media as blob: URLs in `createExportCompositor`.
 *
 * Quantization runs in a worker pool when available (plans/020); the main
 * thread keeps the decode/composite loop moving. Frames are always written in
 * timeline order — completion order from the pool may differ.
 */

import { GIFEncoder, applyPalette, quantize } from "gifenc";

import {
  createExportCompositor,
  createExportCompositorFromMedia,
  planFrameTimes,
  seekTo,
} from "./exportCompositor";
import { yieldToMain } from "./exportYield";
import { throwIfAborted } from "./exportCancel";
import { openSequentialMedia } from "./sequentialMedia";
import type { FaceCamTrack } from "../lib/faceCamSync";
import type { ExportSink } from "./exportSink";
import { createDitherPalettizer } from "./gifDither";
import {
  createGifQuantizePool,
  OrderedPromiseQueue,
  type QuantizedFrame,
} from "./gifQuantizePool";
import type { ResolvedExportParams } from "./exportSettings";
import { useEditorStore } from "../store";
import { GpuContextLostError } from "../render/gpuLifecycle";

/** Flush the encoder's buffer to disk once it grows past this, so the whole
 *  GIF never sits in RAM. */
const GIF_FLUSH_THRESHOLD = 4 * 1024 * 1024;

function throwIfGpuLost(isLost: () => boolean): void {
  if (isLost()) throw new GpuContextLostError();
}

export async function renderGifToSink(
  sink: ExportSink,
  screenUrl: string,
  faceCam: FaceCamTrack,
  params: ResolvedExportParams,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const { width, height, fps, gifColors, gifDither, gifSpeed } = params;
  // GIF is the one consumer of getImageData — the only path that wants a
  // CPU-resident canvas (see CompositorOptions.cpuReadback).
  const sequential = await openSequentialMedia(screenUrl, faceCam).catch(() => null);
  const session = sequential
    ? await createExportCompositorFromMedia(sequential.media, width, height, { cpuReadback: true })
    : await createExportCompositor(screenUrl, faceCam, width, height, { cpuReadback: true });
  const { ctx, video, camera, segments, drawAt, dispose, stats, isGpuLost } =
    session;
  if (!ctx) {
    dispose();
    throw new Error("GIF export requires a readable canvas context");
  }

  const pool = createGifQuantizePool(width, height, gifColors, gifDither);
  // Main-thread dither only for the fallback path — each worker builds its own.
  const ditherApplyPalette =
    pool || !gifDither ? null : createDitherPalettizer(width, height);

  try {
    // Speed > 1 samples the timeline less often but keeps the same per-frame
    // delay, so playback finishes sooner (setpts-style) without changing
    // display smoothness. Clamp is already applied in resolveExportParams.
    const sampleFps = fps / Math.max(1, gifSpeed);
    const frameTimes = planFrameTimes(segments, sampleFps);
    const firstT = frameTimes[0] ?? segments[0]?.start ?? 0;

    // Warm the first frame and prove the canvas is readable (not tainted).
    // Sequential surfaces can't taint (WebCodecs pixels), so only the
    // element-based fallback needs the priming seek. Use the same mid-slot
    // time as the encode loop — exact t=0 often paints blank in WebKit.
    if (!sequential) {
      await seekTo(video, firstT);
      if (camera) await seekTo(camera, firstT).catch(() => undefined);
    }
    throwIfGpuLost(isGpuLost);
    drawAt(firstT);
    try {
      ctx.getImageData(0, 0, 1, 1);
    } catch {
      throw new Error(
        "export canvas is tainted — cannot encode GIF. Try restarting the app.",
      );
    }

    const gif = GIFEncoder();
    const delayCs = Math.max(2, Math.round(100 / fps));
    const format = "rgb565" as const;
    let framesWritten = 0;
    let lastPercent = -1;

    const reportProgress = () => {
      // Tied to frames *written*, not submitted, so the bar stays truthful.
      const ratio = Math.min(1, framesWritten / frameTimes.length);
      const percent = Math.round(ratio * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        useEditorStore.getState().setExportProgress(ratio);
      }
    };

    const flushIfNeeded = async () => {
      const pending = gif.stream.bytesView();
      if (pending.length >= GIF_FLUSH_THRESHOLD) {
        await sink.append(pending.slice());
        gif.stream.reset();
      }
    };

    const writeFrame = async (frame: QuantizedFrame) => {
      gif.writeFrame(frame.index, width, height, {
        palette: frame.palette,
        delay: delayCs,
        ...(framesWritten === 0 ? { repeat: 0 } : {}),
      });
      framesWritten += 1;
      reportProgress();
      await flushIfNeeded();
    };

    const reader =
      sequential?.begin(frameTimes, { mode: "video-frame" }) ?? null;

    const queue = pool ? new OrderedPromiseQueue<QuantizedFrame>(pool.depth) : null;

    // GIF is the only format that reads pixels back, and it pays for it twice:
    // `compose()` blits the GPU canvas into a 2D canvas (the profiler's
    // `readback` phase), then `getImageData` copies that into a fresh array.
    // Bucketing the second copy separately is what tells us whether collapsing
    // the two is worth the risk — see plans/005.
    let getImageDataMs = 0;
    const loopStart = performance.now();

    for (const t of frameTimes) {
      throwIfAborted(signal);
      if (reader) {
        await reader.nextFrame();
      } else {
        await seekTo(video, t);
        if (camera) await seekTo(camera, t).catch(() => undefined);
      }
      drawAt(t);
      throwIfGpuLost(isGpuLost);

      const readStart = performance.now();
      const { data } = ctx.getImageData(0, 0, width, height);
      getImageDataMs += performance.now() - readStart;

      if (pool && queue) {
        const ready = await queue.push(pool.submit(data));
        if (ready) await writeFrame(ready);
      } else {
        const palette = quantize(data, gifColors, { format });
        const index = ditherApplyPalette
          ? ditherApplyPalette(data, palette)
          : applyPalette(data, palette, format);
        await writeFrame({ palette, index });
        // Pool awaits already yield; keep yieldToMain on the fallback path.
        if (framesWritten % 3 === 0) {
          await yieldToMain();
          throwIfAborted(signal);
        }
      }
    }

    if (queue) {
      for await (const frame of queue.drain()) {
        throwIfAborted(signal);
        await writeFrame(frame);
      }
    }

    if (framesWritten === 0) throw new Error("GIF export produced no frames");

    const wallMs = performance.now() - loopStart;
    const perFrameMs = wallMs / framesWritten;
    const readShare = (getImageDataMs / framesWritten / perFrameMs) * 100;
    console.info(
      `[export] gif loop done in ${(wallMs / 1000).toFixed(1)}s ` +
        `(${(framesWritten / (wallMs / 1000)).toFixed(1)} fps) — ` +
        `${perFrameMs.toFixed(1)}ms/frame, ` +
        `getImageData ${(getImageDataMs / framesWritten).toFixed(2)}ms/frame ` +
        `(${readShare.toFixed(1)}% of frame time)`,
    );
    const breakdown = stats();
    if (breakdown) console.info(`[export] gif composite breakdown: ${breakdown}`);

    gif.finish(); // writes the trailer into the buffer
    const tail = gif.stream.bytesView();
    if (tail.length > 0) await sink.append(tail.slice());
  } finally {
    pool?.dispose();
    dispose();
  }
}

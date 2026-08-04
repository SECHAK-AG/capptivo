/**
 * MP4 export via WebCodecs Annex-B H.264 → Rust ffmpeg `-c copy` mux.
 *
 * Pixi compose and H.264 encode stay in the WebView; container mux and file IO
 * run in the ffmpeg sidecar, so WebView2 is never also writing the MP4. Only
 * compressed bytes cross IPC, which is what makes this the fast route.
 *
 * Every wait in the loop is watched (`exportStall.ts`). A WebCodecs encoder that
 * stops emitting chunks is a route failure, not a hang — the caller then falls
 * through to the RGBA route.
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
import {
  adaptEncodeDepth,
  encodeDepthCeiling,
  seedEncodeDepth,
} from "./encodeBackpressure";
import { throwIfAborted } from "./exportCancel";
import {
  FLUSH_STALL_MS,
  StallWatchdog,
  withDeadline,
} from "./exportStall";
import { throttledProgress } from "./exportProgress";
import type { ResolvedExportParams } from "./exportSettings";
import { GpuContextLostError } from "../render/gpuLifecycle";
import { describeError } from "../../recorder/store";
import type { AnnexBEncodeTuning } from "./annexBProbe";
import { isAnnexBStartCode, isH264Keyframe } from "./h264Keyframe";

export {
  ANNEX_B_CODEC,
  H264_KEYFRAME_INTERVAL_SEC,
  isAnnexBStartCode,
  isH264Keyframe,
} from "./h264Keyframe";

/** Cap in-flight IPC writes so encode does not outrun the ffmpeg pipe. */
const MAX_PENDING_WRITES = 6;

function throwIfGpuLost(isLost: () => boolean): void {
  if (isLost()) throw new GpuContextLostError();
}

/**
 * Compose + WebCodecs Annex-B encode → ffmpeg stream-copy MP4 at `path`.
 * Audio is attached afterward by the caller (video-only + post-mux).
 */
export async function renderMp4ViaFfmpegH264(
  path: string,
  screenUrl: string,
  faceCam: FaceCamTrack,
  params: ResolvedExportParams,
  signal: AbortSignal,
  tuning: AnnexBEncodeTuning,
): Promise<void> {
  const { width, height, fps, bitrate } = params;
  throwIfAborted(signal);

  const handle = await commands.beginExportH264Stream({ path, fps });
  let settled = false;
  const abortMux = async (reason: string) => {
    if (settled) return;
    settled = true;
    await commands.abortExportH264Stream(handle, reason).catch(() => undefined);
  };

  const sequential = await openSequentialMedia(screenUrl, faceCam, "annexb");
  const session = sequential
    ? await createExportCompositorFromMedia(sequential.media, width, height)
    : await createExportCompositor(screenUrl, faceCam, width, height);
  const {
    canvas,
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

  let writeChain: Promise<void> = Promise.resolve();
  let writeError: Error | null = null;
  let pendingWrites = 0;
  let framesEncoded = 0;
  let checkedAnnexB = false;
  /**
   * Monotonic evidence of forward motion, for the stall watchdog: chunks the
   * encoder has produced plus writes ffmpeg has consumed. If neither moves, the
   * pipeline is dead no matter what the queue counters say.
   */
  let progressToken = 0;

  const fail = (e: unknown) => {
    if (!writeError) writeError = new Error(describeError(e));
  };

  const enqueueChunk = (chunk: EncodedVideoChunk) => {
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    if (!checkedAnnexB) {
      checkedAnnexB = true;
      if (!isAnnexBStartCode(buf)) {
        fail(
          "WebCodecs did not emit Annex-B H.264 (no start code) — cannot mux with ffmpeg",
        );
        return;
      }
    }
    progressToken += 1;
    pendingWrites += 1;
    writeChain = writeChain
      .then(async () => {
        if (writeError || signal.aborted) return;
        await commands.writeExportH264Chunk(handle, buf);
      })
      .catch(fail)
      .finally(() => {
        pendingWrites = Math.max(0, pendingWrites - 1);
        progressToken += 1;
      });
  };

  const encoder = new VideoEncoder({
    output: (chunk) => enqueueChunk(chunk),
    error: fail,
  });

  let encodeDepth = seedEncodeDepth(width, height, fps);
  const maxEncodeDepth = encodeDepthCeiling(fps);
  const frameBudgetMs = 1000 / Math.max(1, fps);
  let emaCompositeMs = 0;
  let emaEncodeWaitMs = 0;
  let adaptFrames = 0;

  const ema = (prev: number, sample: number, n: number) =>
    n === 0 ? sample : 0.2 * sample + 0.8 * prev;

  try {
    encoder.configure({
      codec: tuning.codec,
      width,
      height,
      bitrate,
      framerate: fps,
      bitrateMode: "variable",
      latencyMode: tuning.latencyMode,
      hardwareAcceleration: tuning.hardwareAcceleration,
      avc: { format: "annexb" },
    });

    const frameDurationUs = Math.round(1_000_000 / Math.max(1, fps));
    const frameTimes = planFrameTimes(segments, fps);
    const reader =
      sequential?.begin(frameTimes, { mode: "video-frame" }) ?? null;
    const progress = throttledProgress(frameTimes.length);

    console.info(
      `[export] ffmpeg-h264: path=${reader ? "sequential" : "seek"} ` +
        `compositor=${backend} frames=${frameTimes.length} ` +
        `codec=${tuning.codec} hw=${tuning.hardwareAcceleration} ` +
        `latency=${tuning.latencyMode} encodeDepthSeed=${encodeDepth}`,
    );

    let timestampUs = 0;
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
            `[export] ffmpeg-h264 seek clamp: wanted ${t.toFixed(3)}s ` +
              `got ${video.currentTime.toFixed(3)}s`,
          );
        }
      }

      throwIfGpuLost(isGpuLost);
      const composeStart = performance.now();
      drawAt(t);
      throwIfGpuLost(isGpuLost);
      const composeMs = performance.now() - composeStart;
      emaCompositeMs = ema(emaCompositeMs, composeMs, adaptFrames);

      // Backpressure: encoder queue + IPC write pipeline. Watched, because this
      // is the exact loop that used to spin forever when the encoder went quiet.
      const waitStart = performance.now();
      const watchdog = new StallWatchdog(
        "annex-b encode backpressure",
        undefined,
        waitStart,
      );
      while (
        encoder.encodeQueueSize >= encodeDepth ||
        pendingWrites >= MAX_PENDING_WRITES
      ) {
        watchdog.check(progressToken);
        await writeChain.catch(() => undefined);
        if (writeError) throw writeError;
        throwIfAborted(signal);
        if (encoder.encodeQueueSize >= encodeDepth) {
          await yieldToMain();
        }
      }
      const waitMs = performance.now() - waitStart;
      if (waitMs > 0) {
        emaEncodeWaitMs = ema(emaEncodeWaitMs, waitMs, adaptFrames);
      }

      const frame = new VideoFrame(canvas as CanvasImageSource, {
        timestamp: timestampUs,
        duration: frameDurationUs,
      });
      try {
        encoder.encode(frame, {
          keyFrame: isH264Keyframe(framesEncoded, fps),
        });
        framesEncoded += 1;
      } finally {
        frame.close();
      }

      adaptFrames += 1;
      if (adaptFrames % 8 === 0) {
        encodeDepth = adaptEncodeDepth({
          depth: encodeDepth,
          emaCompositeMs,
          emaEncodeWaitMs,
          frameBudgetMs,
          maxDepth: maxEncodeDepth,
        });
      }

      progress(framesEncoded);
      timestampUs += frameDurationUs;

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

    // A wedged encoder never resolves `flush()`; without a deadline this is the
    // second place an export can hang at 99%.
    await withDeadline(encoder.flush(), FLUSH_STALL_MS, "annex-b encoder flush");
    await withDeadline(writeChain, FLUSH_STALL_MS, "annex-b chunk writes");
    if (writeError) throw writeError;
    if (framesEncoded === 0) {
      throw new Error("ffmpeg h264 export produced no frames");
    }

    const wallMs = performance.now() - loopStart;
    const uploads = uploadStats();
    console.info(
      `[export] ffmpeg-h264 done in ${(wallMs / 1000).toFixed(1)}s ` +
        `(${(framesEncoded / (wallMs / 1000)).toFixed(1)} fps) — ` +
        `depth=${encodeDepth} yields=${yields} yieldMs=${yieldMs.toFixed(0)}` +
        (uploads
          ? ` uploads=${uploads.uploads} skipped=${uploads.skipped}`
          : ""),
    );
    const breakdown = stats();
    if (breakdown) console.info(`[export] composite breakdown: ${breakdown}`);

    settled = true;
    await commands.finishExportH264Stream(handle);
  } catch (e) {
    const reason = describeError(e);
    console.error(`[export] ffmpeg-h264 failed: ${reason}`);
    await abortMux(reason);
    throw e instanceof Error ? e : new Error(reason);
  } finally {
    try {
      if (encoder.state !== "closed") encoder.close();
    } catch {
      /* already torn down */
    }
    dispose();
    if (!settled) {
      await abortMux("export failed");
    }
  }
}

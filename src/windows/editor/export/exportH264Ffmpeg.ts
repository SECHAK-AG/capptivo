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
import { type FaceCamTrack } from "../lib/faceCamSync";
import {
  createExportCompositor,
  createExportCompositorFromMedia,
  planFrameTimes,
} from "./exportCompositor";
import {
  createExportFrameIterator,
  warnSeekPath,
} from "./exportFrameLoop";
import {
  ensureSeekableForSeekPath,
  openExportSequentialMedia,
} from "./exportMediaOpen";
import { exportLog } from "./exportLog";
import { shouldYieldNow, yieldToMain } from "./exportYield";
import {
  adaptEncodeDepth,
  canvasVideoFrameEncodeDepthCeiling,
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
import { useEditorStore } from "../store";
import type { AnnexBEncodeTuning } from "./annexBProbe";
import type { ExportSnapshot } from "./exportSnapshot";
import { isAnnexBStartCode, isH264Keyframe } from "./h264Keyframe";

export {
  ANNEX_B_CODEC,
  H264_KEYFRAME_INTERVAL_SEC,
  isAnnexBStartCode,
  isH264Keyframe,
} from "./h264Keyframe";

/** Cap in-flight IPC writes so encode does not outrun the ffmpeg pipe. */
const MAX_PENDING_WRITES = 24;
/** Batch Annex-B chunks before IPC — fewer Tauri round-trips. */
const BATCH_MAX_CHUNKS = 12;
const BATCH_MAX_BYTES = 2_000_000;

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

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
  snapshot: ExportSnapshot,
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

  let sequential;
  let session;
  try {
    const projectId = snapshot.projectId;

    sequential = await openExportSequentialMedia(
      screenUrl,
      faceCam,
      "annexb",
      projectId,
    );
    if (sequential) {
      session = await createExportCompositorFromMedia(
        sequential.media,
        width,
        height,
        { snapshot },
      );
    } else {
      await ensureSeekableForSeekPath(projectId);
      session = await createExportCompositor(screenUrl, faceCam, width, height, {
        snapshot,
      });
    }
  } catch (error) {
    await abortMux(describeError(error));
    throw error;
  }
  const {
    canvas,
    video,
    camera,
    segments,
    drawAt,
    dispose,
    backend,
    gpu,
    stats,
    uploadStats,
    isGpuLost,
  } = session;

  let writeChain: Promise<void> = Promise.resolve();
  let writeError: Error | null = null;
  let pendingWrites = 0;
  let framesEncoded = 0;
  let checkedAnnexB = false;
  const chunkBatch: Uint8Array[] = [];
  let chunkBatchBytes = 0;
  /**
   * Monotonic evidence of forward motion, for the stall watchdog: chunks the
   * encoder has produced plus writes ffmpeg has consumed. If neither moves, the
   * pipeline is dead no matter what the queue counters say.
   */
  let progressToken = 0;

  const fail = (e: unknown) => {
    if (!writeError) writeError = new Error(describeError(e));
  };

  const flushChunkBatch = () => {
    if (chunkBatch.length === 0) return;
    const payload = concatChunks(chunkBatch);
    chunkBatch.length = 0;
    chunkBatchBytes = 0;
    progressToken += 1;
    pendingWrites += 1;
    writeChain = writeChain
      .then(async () => {
        if (writeError || signal.aborted) return;
        await commands.writeExportH264Chunk(handle, payload);
      })
      .catch(fail)
      .finally(() => {
        pendingWrites = Math.max(0, pendingWrites - 1);
        progressToken += 1;
      });
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
    chunkBatch.push(buf);
    chunkBatchBytes += buf.length;
    if (
      chunkBatch.length >= BATCH_MAX_CHUNKS ||
      chunkBatchBytes >= BATCH_MAX_BYTES
    ) {
      flushChunkBatch();
    }
  };

  const encoder = new VideoEncoder({
    output: (chunk) => enqueueChunk(chunk),
    error: fail,
  });

  let encodeDepth = Math.min(
    seedEncodeDepth(width, height, fps),
    canvasVideoFrameEncodeDepthCeiling(fps),
  );
  const maxEncodeDepth = canvasVideoFrameEncodeDepthCeiling(fps);
  const frameBudgetMs = 1000 / Math.max(1, fps);
  let emaCompositeMs = 0;
  let emaEncodeWaitMs = 0;
  let adaptFrames = 0;

  const ema = (prev: number, sample: number, n: number) =>
    n === 0 ? sample : 0.2 * sample + 0.8 * prev;
  let disposeFrames: (() => void) | null = null;

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
    const frames = createExportFrameIterator(
      frameTimes,
      reader,
      reader ? null : { video, camera, faceCam },
      { signal },
    );
    disposeFrames = frames.dispose;
    const progress = throttledProgress(frameTimes.length);

    exportLog(
      `[export] ffmpeg-h264: path=${frames.mode} ` +
        `compositor=${backend} gpu=${gpu} frames=${frameTimes.length} ` +
        `codec=${tuning.codec} hw=${tuning.hardwareAcceleration} ` +
        `latency=${tuning.latencyMode} encodeDepthSeed=${encodeDepth}`,
    );
    if (frames.mode === "seek") warnSeekPath("ffmpeg-h264", frameTimes.length);

    await frames.prime();

    let timestampUs = 0;
    let lastYieldAt = performance.now();
    let yields = 0;
    let yieldMs = 0;
    const loopStart = performance.now();

    for (let i = 0; i < frames.count; i += 1) {
      throwIfAborted(signal);
      if (writeError) throw writeError;
      throwIfGpuLost(isGpuLost);

      await frames.advance(i);
      const t = frames.timeAt(i);

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
        // WebCodecs needs a macrotask to drain encodeQueueSize — microtasks spin.
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
    flushChunkBatch();
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
    exportLog(
      `[export] ffmpeg-h264 done in ${(wallMs / 1000).toFixed(1)}s ` +
        `(${(framesEncoded / (wallMs / 1000)).toFixed(1)} fps) — ` +
        `depth=${encodeDepth} yields=${yields} yieldMs=${yieldMs.toFixed(0)}` +
        (uploads
          ? ` uploads=${uploads.uploads} skipped=${uploads.skipped}`
          : ""),
    );
    const breakdown = stats();
    if (breakdown) exportLog(`[export] composite breakdown: ${breakdown}`);

    settled = true;
    await commands.finishExportH264Stream(handle);
  } catch (e) {
    const reason = describeError(e);
    console.error(`[export] ffmpeg-h264 failed: ${reason}`);
    await abortMux(reason);
    throw e instanceof Error ? e : new Error(reason);
  } finally {
    disposeFrames?.();
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

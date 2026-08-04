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
import { FLUSH_STALL_MS, StallWatchdog, withDeadline } from "./exportStall";
import { throttledProgress } from "./exportProgress";
import { FramePool } from "./framePool";
import {
  ASYNC_READBACK_RING_SIZE,
  FRAME_POOL_SIZE,
  InFlightReadbacks,
} from "./asyncReadbackRing";
import type { ResolvedExportParams } from "./exportSettings";
import { GpuContextLostError } from "../render/gpuLifecycle";
import { describeError } from "../../recorder/store";

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

  // No `cpuReadback`: frames are pulled straight off the GPU into pooled
  // buffers, so the compositor never allocates the software 2D canvas that
  // `getImageData` would need.
  const sequential = await openSequentialMedia(screenUrl, faceCam, "rawvideo");
  const session = sequential
    ? await createExportCompositorFromMedia(sequential.media, width, height)
    : await createExportCompositor(screenUrl, faceCam, width, height);
  const {
    readPixelsInto,
    beginReadPixels,
    tryFinishReadPixels,
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

  const frameBytes = width * height * 4;
  const pool = new FramePool(frameBytes, FRAME_POOL_SIZE);

  // Prove readback works before composing anything. A route that cannot read
  // pixels must fail here, while failing is still cheap, rather than after a
  // few hundred frames of wasted compositing.
  const probeBuffer = pool.acquire();
  if (!probeBuffer || !readPixelsInto(probeBuffer)) {
    if (probeBuffer) pool.release(probeBuffer);
    dispose();
    const reason =
      "rawvideo export requires GPU pixel readback, which this renderer does not provide";
    await abortMux(reason);
    throw new Error(reason);
  }
  pool.release(probeBuffer);

  let writeChain: Promise<void> = Promise.resolve();
  let writeError: Error | null = null;
  let framesEncoded = 0;
  /** Monotonic evidence of forward motion, for the stall watchdog. */
  let progressToken = 0;

  const fail = (e: unknown) => {
    if (!writeError) writeError = new Error(describeError(e));
  };

  /**
   * Hand one pooled buffer to Rust. Ownership transfers for the duration of the
   * write: the buffer goes back to the pool only once the IPC call has settled,
   * because releasing it earlier would let the next frame overwrite bytes that
   * are still being read.
   */
  const enqueueFrame = (buf: Uint8Array) => {
    writeChain = writeChain
      .then(async () => {
        if (writeError || signal.aborted) return;
        await commands.writeExportRawvideoFrame(handle, buf);
      })
      .catch(fail)
      .finally(() => {
        pool.release(buf);
        progressToken += 1;
      });
  };

  try {
    const frameTimes = planFrameTimes(segments, fps);
    const reader =
      sequential?.begin(frameTimes, { mode: "video-frame" }) ?? null;
    const progress = throttledProgress(frameTimes.length);

    console.info(
      `[export] ffmpeg-rawvideo: path=${reader ? "sequential" : "seek"} ` +
        `compositor=${backend} frames=${frameTimes.length} ` +
        `${width}x${height}@${fps} pool=${FRAME_POOL_SIZE}×${(frameBytes / 1e6).toFixed(1)}MB`,
    );
    if (!reader) {
      // Loud, because this is the difference between minutes and an hour. The
      // reason was already logged by openSequentialMedia; this says what it
      // costs, next to the frame count it will be paid on.
      console.warn(
        `[export] ffmpeg-rawvideo is seeking per frame for all ` +
          `${frameTimes.length} frames — expect an export far slower than realtime`,
      );
    }

    let lastYieldAt = performance.now();
    let driftLogs = 0;
    let yields = 0;
    let yieldMs = 0;
    let readbackMs = 0;
    // The three phases that can each plausibly dominate. Each bucket closes
    // before any await that is not part of its own phase — otherwise waiting on
    // one phase silently inflates another, and the numbers point at the wrong
    // thing.
    let decodeMs = 0;
    let compositeMs = 0;
    const loopStart = performance.now();

    /**
     * Frames whose pixels the GPU is still copying out. Composing frame N while
     * frame N-1 drains is the whole point: a synchronous read has to flush the
     * command queue and wait, which idles the GPU for the entire copy.
     */
    const inFlight = new InFlightReadbacks(ASYNC_READBACK_RING_SIZE);
    /**
     * Latched, not re-tested per frame: whether the renderer can do fenced reads
     * is a property of the GL context, so a single `null` means every later call
     * would also return `null`.
     */
    let asyncReadback = true;

    /**
     * Complete the oldest outstanding readback and hand it to ffmpeg. Blocks
     * only on that one frame's fence — by the time we ask, the ring depth has
     * usually given it long enough to have already signalled.
     */
    const collectOldest = async (): Promise<void> => {
      const head = inFlight.peek();
      if (!head) return;
      const watchdog = new StallWatchdog("rawvideo GPU readback");
      const waitStart = performance.now();
      for (;;) {
        const status = tryFinishReadPixels(head.ticket, head.buffer);
        if (status === "done") {
          readbackMs += performance.now() - waitStart;
          inFlight.shift();
          enqueueFrame(head.buffer);
          framesEncoded += 1;
          progress(framesEncoded);
          return;
        }
        if (status === "failed") {
          inFlight.shift();
          pool.release(head.buffer);
          throw new Error("rawvideo readback failed mid-export");
        }
        // Pending. Never spin on the fence with a blocking wait — that is the
        // stall this path exists to remove.
        watchdog.check(progressToken);
        throwIfAborted(signal);
        throwIfGpuLost(isGpuLost);
        if (writeError) throw writeError;
        await yieldToMain();
      }
    };

    for (const t of frameTimes) {
      throwIfAborted(signal);
      if (writeError) throw writeError;
      throwIfGpuLost(isGpuLost);

      const decodeStart = performance.now();
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

      decodeMs += performance.now() - decodeStart;

      throwIfGpuLost(isGpuLost);
      const composeStart = performance.now();
      drawAt(t);
      compositeMs += performance.now() - composeStart;
      throwIfGpuLost(isGpuLost);

      // Free a ring slot *before* taking a buffer, so the pool can never be
      // drained by frames that are only waiting on a fence — the one shape of
      // backpressure the write chain below cannot relieve.
      if (inFlight.isFull) await collectOldest();

      // Backpressure is the pool running dry: every buffer is still in flight
      // to FFmpeg. Watched, because an ffmpeg child that stops draining its
      // stdin pipe would otherwise park this loop forever with the progress bar
      // frozen. Never allocate a replacement buffer here — that would remove
      // the only thing bounding this loop's memory.
      const watchdog = new StallWatchdog("rawvideo write backpressure");
      let buf = pool.acquire();
      while (!buf) {
        watchdog.check(progressToken);
        await writeChain.catch(() => undefined);
        if (writeError) throw writeError;
        throwIfAborted(signal);
        buf = pool.acquire();
        if (!buf) await yieldToMain();
      }

      const ticket = asyncReadback ? beginReadPixels() : null;
      if (ticket == null) {
        asyncReadback = false;
        // Drain first if the fenced path is failing over mid-export: everything
        // still in the ring was composed before this frame, and writing this one
        // ahead of them would reorder the video.
        while (inFlight.size > 0) await collectOldest();
        const readStart = performance.now();
        if (!readPixelsInto(buf)) {
          pool.release(buf);
          throw new Error("rawvideo readback failed mid-export");
        }
        readbackMs += performance.now() - readStart;
        enqueueFrame(buf);
        framesEncoded += 1;
        progress(framesEncoded);
      } else {
        // Ordering is the contract: frames leave this ring in the order they
        // were composed, so ffmpeg's stdin stays a straight frame sequence.
        inFlight.push({ ticket, buffer: buf });
      }

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

    // Every composed frame must reach ffmpeg: the tail of the pipeline is still
    // on the GPU when the last frame is drawn, and dropping it would truncate
    // the video by the ring depth.
    while (inFlight.size > 0) await collectOldest();

    await withDeadline(writeChain, FLUSH_STALL_MS, "rawvideo frame writes");
    if (writeError) throw writeError;
    if (framesEncoded === 0) {
      throw new Error("ffmpeg rawvideo export produced no frames");
    }

    const wallMs = performance.now() - loopStart;
    const uploads = uploadStats();
    /** `<name> Nms/frame (P% of wall)` — the shape that makes phases comparable. */
    const phase = (name: string, ms: number) =>
      `${name} ${(ms / Math.max(1, framesEncoded)).toFixed(2)}ms/frame ` +
      `(${((ms / Math.max(1, wallMs)) * 100).toFixed(1)}%)`;
    console.info(
      `[export] ffmpeg-rawvideo done in ${(wallMs / 1000).toFixed(1)}s ` +
        `(${(framesEncoded / (wallMs / 1000)).toFixed(1)} fps) — ` +
        `${phase(reader ? "decode(linear)" : "decode(seek)", decodeMs)}, ` +
        `${phase("composite", compositeMs)}, ` +
        `${phase(`readback(${asyncReadback ? "async" : "sync"})`, readbackMs)}, ` +
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

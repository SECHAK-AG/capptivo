/**
 * Export: composite the timeline to MP4 / WebM / GIF.
 *
 * One compositor (the same Pixi one the preview uses, so every route is
 * WYSIWYG) and a small, fixed set of encode routes:
 *
 * - **MP4** — `planMp4Routes()` in `exportRouting.ts`. Annex-B WebCodecs →
 *   ffmpeg `-c copy` when an encoder has been *verified* on this machine
 *   (`annexBProbe.ts`), otherwise RGBA readback → ffmpeg hardware encode. The
 *   RGBA route needs no WebCodecs at all, so it is always available as the floor.
 * - **WebM** — mediabunny muxes in-webview (VP9/AV1/VP8 + in-container audio).
 * - **GIF** — gifenc.
 *
 * Every wait is watched (`exportStall.ts`): an encoder that goes quiet fails its
 * route and the next one is tried. Nothing in here can hang the progress bar.
 *
 * Export media is loaded as `blob:` URLs so the canvas is never tainted by
 * `media://`.
 */

import { save } from "@tauri-apps/plugin-dialog";
import { translateNow } from "@/lib/i18n";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  CanvasSource,
  canEncodeVideo,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type VideoCodec,
  type VideoEncodingAdditionalOptions,
} from "mediabunny";

import { totalKeptDuration } from "@/engine";
import { isWindows, mediaUrl } from "@/lib/platform";
import { commands } from "../../../ipc/bindings";
import { describeError } from "../../recorder/store";
import { logClientError } from "@/lib/errorLogging";
import { useEditorStore } from "../store";
import {
  createExportCompositor,
  createExportCompositorFromMedia,
  planFrameTimes,
  seekTo,
} from "./exportCompositor";
import { openSequentialMedia } from "./sequentialMedia";
import { shouldYieldNow, yieldToMain } from "./exportYield";
import { AdaptiveEncodeQueue } from "./encodeBackpressure";
import { ExportSink } from "./exportSink";
import { openExportAudioTrack } from "./exportAudioTrack";
import { renderGifToSink } from "./exportGif";
import { renderMp4ViaFfmpegH264 } from "./exportH264Ffmpeg";
import { renderMp4ViaFfmpegRawvideo } from "./exportRawvideoFfmpeg";
import { probeAnnexBConfig } from "./annexBProbe";
import { planMp4Routes, type Mp4Route } from "./exportRouting";
import {
  ENCODE_STALL_MS,
  FLUSH_STALL_MS,
  isExportStallError,
  withDeadline,
} from "./exportStall";
import { throttledProgress } from "./exportProgress";
import {
  beginExportAbort,
  endExportAbort,
  isExportCancelled,
  throwIfAborted,
} from "./exportCancel";
import {
  DEFAULT_EXPORT_SETTINGS,
  estimateExportBytes,
  resolveExportParams,
  type ExportAudioEnhance,
  type ExportSettings,
  type ResolvedExportParams,
} from "./exportSettings";
import { resolveStageSize } from "../lib/composition";
import { faceCamMediaTime, type FaceCamTrack } from "../lib/faceCamSync";
import {
  GpuContextLostError,
  isGpuContextLostError,
  markPreferDomCanvasForExport,
  reclaimGpuAfterLoss,
  reloadEditorForDeadGpu,
} from "../render/gpuLifecycle";

export { cancelActiveExport } from "./exportCancel";

function throwIfGpuLost(isLost: () => boolean): void {
  if (isLost()) throw new GpuContextLostError();
}

async function pickSavePath(
  suggestedName: string,
  fileExt: "mp4" | "webm" | "gif",
): Promise<string | null> {
  const path = await save({
    defaultPath: suggestedName,
    filters: [
      fileExt === "gif"
        ? { name: "GIF animation", extensions: ["gif"] }
        : fileExt === "webm"
          ? { name: "WebM video", extensions: ["webm"] }
          : { name: "MP4 video", extensions: ["mp4"] },
    ],
  });
  return path;
}

export async function exportProject(
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
): Promise<void> {
  const store = useEditorStore.getState();
  const { project, screenUrl, sourceVideoSize } = store;
  if (!project || !screenUrl || !sourceVideoSize) return;

  // Carried as one value so no export path can read the face-cam without the
  // offset that puts it on the screen timeline.
  const faceCam: FaceCamTrack = {
    url: store.cameraUrl,
    offsetMs: store.cameraOffsetMs,
  };

  // Same stage resolution the preview composites at — the ratio picker is the
  // single source of output size.
  const stage = resolveStageSize(store.aspectRatioPresetId, sourceVideoSize);
  const resolved = resolveExportParams(settings, stage.width, stage.height);
  const fileExt = resolved.ext;
  const base =
    (project.title ?? "recording").replace(/[^\w.-]+/g, "-") || "recording";
  const suggestedName = `${base}.${fileExt}`;

  store.setExporting(true);
  store.setExportError(null);
  const signal = beginExportAbort();

  // Pick the destination up front: the encoder streams straight into this file
  // as frames are produced, so peak memory is one chunk rather than the whole
  // encoded video. Cancelling here also skips all render work. The chosen path
  // is now final — no route may rewrite the extension, because every route
  // produces the container the user asked for.
  let path: string | null = null;
  try {
    store.setExportStatus(translateNow("export.status.choosePath"));
    path = await pickSavePath(suggestedName, fileExt);
  } catch (e) {
    store.setExportError(describeError(e));
    logClientError("export:pickPath", e);
  }
  if (!path || signal.aborted) {
    endExportAbort();
    const s = useEditorStore.getState();
    s.setExporting(false);
    s.setExportStatus(null);
    return;
  }

  const keptDuration =
    store.segments.length > 0
      ? totalKeptDuration(store.segments)
      : store.duration;
  try {
    await commands.checkExportDiskSpace({
      path,
      needed: estimateExportBytes(resolved, keptDuration),
    });
  } catch (e) {
    endExportAbort();
    store.setExportError(describeError(e));
    logClientError("export:diskSpace", e);
    store.setExporting(false);
    store.setExportStatus(null);
    return;
  }

  store.setExportStatus(
    translateNow(
      resolved.format === "gif"
        ? "export.status.renderingGif"
        : "export.rendering",
    ),
  );
  let sink: ExportSink | null = null;
  // Prepared audio track (trimmed/enhanced) built while seekable-ensure runs —
  // when mediabunny can open it, packets mux into the container during encode
  // and the post-export FFmpeg attach is skipped.
  let audioPrep: Promise<PreparedExportAudio | null> | null = null;
  let audioAbsPath: string | null = null;
  let gpuWasLost = false;
  try {
    // Kick audio prepare before ensureSeekable so FFmpeg overlaps that work.
    if (resolved.format !== "gif") {
      const outName = `capptivo-export-audio-${crypto.randomUUID()}.${
        resolved.container === "webm" ? "webm" : "m4a"
      }`;
      audioPrep = prepareExportAudioTrack(outName, settings.audioEnhance).catch(
        (e) => {
          console.warn(
            "export audio prepare failed; will fall back to post-mux",
            e,
          );
          return null;
        },
      );
    }

    // Older recordings were written as fragmented MP4, which WebKit's export
    // seek path (used when WebCodecs can't decode the source codec) can't seek
    // past its first fragment — freezing the export. Guarantee a seekable
    // progressive source before rendering; a fast no-op once migrated.
    console.info(`[export] ensureSeekableRecording(${project.id})…`);
    const t0 = performance.now();
    await commands.ensureSeekableRecording(project.id);
    throwIfAborted(signal);
    console.info(
      `[export] ensureSeekableRecording done in ${(performance.now() - t0).toFixed(0)}ms ` +
        `screenUrl=${screenUrl}`,
    );

    if (resolved.format === "gif") {
      sink = await ExportSink.open(path);
      await renderGifToSink(sink, screenUrl, faceCam, resolved, signal);
      store.setExportStatus(translateNow("export.status.saving"));
      const saved = await sink.finish();
      sink = null;
      await notifyDone(saved);
      return;
    }

    const prepared = audioPrep ? await audioPrep : null;
    throwIfAborted(signal);
    audioAbsPath = prepared?.absPath ?? null;

    const attachAudioAndFinish = async (videoPath: string) => {
      store.setExportStatus(translateNow("export.status.saving"));
      if (prepared) {
        store.setExportStatus(translateNow("export.status.addingAudio"));
        await commands
          .attachExportAudio({
            videoPath,
            audioPath: prepared.absPath,
          })
          .catch(async (e) => {
            console.warn("export audio attach failed; trying full mux", e);
            await muxRecordedAudio(videoPath, settings.audioEnhance);
          });
      } else {
        await muxRecordedAudio(videoPath, settings.audioEnhance).catch((e) =>
          console.warn("export audio mux failed; keeping silent video", e),
        );
      }
      await notifyDone(videoPath);
    };

    if (resolved.container === "mp4") {
      await exportMp4(path, screenUrl, faceCam, resolved, signal);
      await attachAudioAndFinish(path);
      return;
    }

    // WebM: mediabunny muxes in-webview, audio included in-container when the
    // prepared track opens.
    sink = await ExportSink.open(path);
    const audioMuxed = await renderWebmToSink(
      sink,
      screenUrl,
      faceCam,
      resolved,
      prepared?.mediaUrl ?? null,
      signal,
    );
    throwIfAborted(signal);
    store.setExportStatus(translateNow("export.status.saving"));
    const saved = await sink.finish();
    sink = null;

    if (audioMuxed) {
      await notifyDone(saved);
    } else {
      await attachAudioAndFinish(saved);
    }
  } catch (e) {
    await sink?.abort(e);
    // Cancel is intentional — don't surface it as an export failure toast.
    if (!isExportCancelled(e)) {
      if (isGpuContextLostError(e)) {
        gpuWasLost = true;
        markPreferDomCanvasForExport("export GpuContextLostError");
        useEditorStore
          .getState()
          .setExportError(translateNow("export.error.gpuContextLost"));
        logClientError("export:gpu", e);
      } else {
        useEditorStore.getState().setExportError(describeError(e));
        logClientError("export", e);
      }
    }
  } finally {
    endExportAbort();
    // Prepare may still be in flight if we failed before awaiting it — wait and
    // delete so capptivo-export-audio-* never accumulates in the project dir.
    if (!audioAbsPath && audioPrep) {
      const leftover = await audioPrep.catch(() => null);
      audioAbsPath = leftover?.absPath ?? null;
    }
    if (audioAbsPath) {
      void commands
        .removeTempFile({ path: audioAbsPath })
        .catch(() => undefined);
    }
    // Reclaim BEFORE clearing exporting — otherwise preview remounts into a
    // dead WebView2 GPU and the next export fails with a fake "no WebGL".
    let reloadForDeadGpu = false;
    if (gpuWasLost) {
      const { ok } = await reclaimGpuAfterLoss();
      if (!ok) {
        await useEditorStore.getState().flushEditorPersist();
        reloadForDeadGpu = true;
      }
    }
    const s = useEditorStore.getState();
    s.setExporting(false);
    s.setExportProgress(0);
    s.setExportStatus(null);
    if (reloadForDeadGpu) {
      reloadEditorForDeadGpu();
    }
  }
}

/**
 * Render an MP4 by walking the planned routes until one produces a file.
 *
 * Only route *failures* advance the list. Cancellation and GPU loss are
 * terminal: retrying a cancelled export would ignore the user, and retrying on a
 * dead GPU context just fails again more slowly.
 */
async function exportMp4(
  path: string,
  screenUrl: string,
  faceCam: FaceCamTrack,
  resolved: ResolvedExportParams,
  signal: AbortSignal,
): Promise<void> {
  const forceRgba = import.meta.env.VITE_CAPPTIVO_RAWVIDEO_EXPORT === "1";
  // Skipped outright, not merely ignored: the probe spins up a real encoder at
  // full resolution, so paying for it and discarding the answer would keep most
  // of the cost this skip exists to remove.
  const skipAnnexB = isWindows || forceRgba;

  // Verified, not merely declared: this is a real encode of real frames with a
  // deadline, and it is the difference between failing in a few hundred
  // milliseconds and freezing an export at 1% forever.
  const annexBTuning = skipAnnexB
    ? null
    : await probeAnnexBConfig(
        resolved.width,
        resolved.height,
        resolved.bitrate,
        resolved.fps,
        { windows: isWindows },
      );
  throwIfAborted(signal);

  const routes = planMp4Routes({
    windows: isWindows,
    annexBVerified: annexBTuning != null,
    forceRgba,
  });
  console.info(`[export] mp4 route plan: ${routes.join(" → ")}`);

  // Stated as an invariant rather than asserted away: if the planner ever emits
  // this route without a verified encoder, that surfaces as an ordinary route
  // failure and the export continues on RGBA instead of throwing at the user.
  const runRoute = (route: Mp4Route): Promise<void> => {
    if (route === "annexb-ffmpeg") {
      if (!annexBTuning) {
        throw new Error("annexb-ffmpeg planned without a verified encoder");
      }
      return renderMp4ViaFfmpegH264(
        path,
        screenUrl,
        faceCam,
        resolved,
        signal,
        annexBTuning,
      );
    }
    return renderMp4ViaFfmpegRawvideo(
      path,
      screenUrl,
      faceCam,
      resolved,
      signal,
    );
  };

  const failures: string[] = [];
  for (const route of routes) {
    try {
      console.info(`[export] path=${route}`);
      await runRoute(route);
      throwIfAborted(signal);
      return;
    } catch (e) {
      if (isExportCancelled(e) || isGpuContextLostError(e)) throw e;
      const reason = describeError(e);
      failures.push(`${route}: ${reason}`);
      logClientError(`export:${route}`, e);
      console.warn(
        `[export] ${route} failed (${reason})` +
          (isExportStallError(e) ? " [stalled]" : ""),
      );
    }
  }

  throw new Error(`MP4 export failed — ${failures.join("; ")}`);
}

/**
 * The editor's volume slider as a linear multiplier for FFmpeg, or `null` when
 * the track is muted. `null` means "export no audio at all" rather than
 * "export silence", so a muted take produces a genuinely video-only file.
 */
function exportAudioGain(): number | null {
  const { muted, volume } = useEditorStore.getState();
  if (muted) return null;
  const gain = Math.max(0, Math.min(1, volume / 100));
  return gain <= 0 ? null : gain;
}

/**
 * Mux the recorded audio into the just-saved (video-only) export, trimmed to the
 * same kept segments the video uses. Rust runs FFmpeg (`-c:v copy`, so no video
 * re-encode) and no-ops for silent recordings.
 */
async function muxRecordedAudio(
  videoPath: string,
  preset: ExportAudioEnhance,
): Promise<void> {
  const { project, duration, segments } = useEditorStore.getState();
  if (!project) return;

  const gain = exportAudioGain();
  if (gain === null) return;

  const kept =
    segments.length > 0
      ? segments.map((s) => ({ start: s.start, end: s.end }))
      : [{ start: 0, end: duration }];

  useEditorStore
    .getState()
    .setExportStatus(translateNow("export.status.addingAudio"));
  await commands.muxExportAudio({
    projectId: project.id,
    videoPath,
    audioSource: project.files.screen,
    segments: kept,
    preset,
    hasSystemAudio: project.capture.capturedSystemAudio,
    gain,
  });
}

/**
 * Trim (+ optional enhance) the recorded audio to a sidecar file in the project
 * directory (so the WebView can read it over `media://`). Returns absolute path
 * + media URL, or `null` when there is no audio.
 */
type PreparedExportAudio = { absPath: string; mediaUrl: string };

async function prepareExportAudioTrack(
  outName: string,
  preset: ExportAudioEnhance,
): Promise<PreparedExportAudio | null> {
  const { project, duration, segments } = useEditorStore.getState();
  if (!project) return null;

  const gain = exportAudioGain();
  if (gain === null) return null;

  const kept =
    segments.length > 0
      ? segments.map((s) => ({ start: s.start, end: s.end }))
      : [{ start: 0, end: duration }];

  const absPath = await commands.prepareExportAudio({
    projectId: project.id,
    outName,
    audioSource: project.files.screen,
    segments: kept,
    preset,
    hasSystemAudio: project.capture.capturedSystemAudio,
    gain,
  });
  if (!absPath) return null;
  if (preset !== "off") {
    console.info(
      `[export] audio enhance=${preset} systemAudio=${project.capture.capturedSystemAudio}`,
    );
  }
  return { absPath, mediaUrl: mediaUrl(project.id, outName) };
}

/** Keyframe spacing: fewer I-frames → less encoder work at the same bitrate. */
const EXPORT_KEYFRAME_INTERVAL_SEC = 4;

/** WebM codec preference — first the browser can encode at size wins. */
const WEBM_CODECS: VideoCodec[] = ["vp9", "av1", "vp8"];

type VideoEncodeTuning = {
  codec: VideoCodec;
  latencyMode: NonNullable<VideoEncodingAdditionalOptions["latencyMode"]>;
  hardwareAcceleration: NonNullable<
    VideoEncodingAdditionalOptions["hardwareAcceleration"]
  >;
};

/**
 * Pick the fastest supported encoder config without changing the caller's
 * bitrate / resolution. Prefers hardware, then tries `realtime` before
 * `quality`. Backpressure in the export loop keeps the encoder fed so
 * `realtime` does not need to drop frames to keep up.
 */
async function pickWebmEncodeTuning(
  width: number,
  height: number,
  bitrate: number,
): Promise<VideoEncodeTuning | null> {
  const hardwareModes: NonNullable<
    VideoEncodingAdditionalOptions["hardwareAcceleration"]
  >[] = ["prefer-hardware", "no-preference", "prefer-software"];
  const latencyModes: NonNullable<
    VideoEncodingAdditionalOptions["latencyMode"]
  >[] = ["realtime", "quality"];

  for (const hardwareAcceleration of hardwareModes) {
    for (const latencyMode of latencyModes) {
      for (const codec of WEBM_CODECS) {
        if (
          await canEncodeVideo(codec, {
            width,
            height,
            bitrate,
            latencyMode,
            hardwareAcceleration,
          })
        ) {
          return { codec, latencyMode, hardwareAcceleration };
        }
      }
    }
  }
  return null;
}

/**
 * Deterministic WebM export: decode each source frame, composite it, and encode
 * it via WebCodecs (mediabunny). Unlike a realtime capture this does not depend
 * on the machine keeping up with playback — it renders exactly `fps` frames per
 * second of output regardless of how long each composite takes, so the result is
 * always smooth with no dropped frames.
 *
 * Returns whether audio was muxed into the container (WebM can; the caller
 * post-muxes when it could not).
 */
async function renderWebmToSink(
  sink: ExportSink,
  screenUrl: string,
  faceCam: FaceCamTrack,
  params: ResolvedExportParams,
  audioMediaUrl: string | null,
  signal: AbortSignal,
): Promise<boolean> {
  const { width, height, fps, bitrate } = params;
  throwIfAborted(signal);

  const tuning =
    typeof VideoEncoder !== "undefined"
      ? await pickWebmEncodeTuning(width, height, bitrate)
      : null;

  if (!tuning) {
    throw new Error(
      "WebM export needs a VP9/AV1/VP8 encoder this system does not provide — export MP4 instead",
    );
  }

  throwIfAborted(signal);
  const sequential = await openSequentialMedia(screenUrl, faceCam, "webcodecs");
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

  const output = new Output({
    format: new WebMOutputFormat(),
    // Pipe each produced chunk straight to disk; 16 MiB batches keep IPC cheap.
    target: new StreamTarget(sink.writable(), { chunked: true }),
  });

  let audioTrack: Awaited<ReturnType<typeof openExportAudioTrack>> = null;
  let audioMuxed = false;

  try {
    const source = new CanvasSource(canvas, {
      codec: tuning.codec,
      bitrate,
      bitrateMode: "variable",
      latencyMode: tuning.latencyMode,
      hardwareAcceleration: tuning.hardwareAcceleration,
      keyFrameInterval: EXPORT_KEYFRAME_INTERVAL_SEC,
    });
    output.addVideoTrack(source, { frameRate: fps });

    if (audioMediaUrl) {
      audioTrack = await openExportAudioTrack(audioMediaUrl);
      if (audioTrack) {
        output.addAudioTrack(audioTrack.source);
        audioMuxed = true;
      }
    }

    await output.start();
    const audioPump = audioTrack ? audioTrack.pump() : Promise.resolve();

    const frameDuration = 1 / fps;
    const frameTimes = planFrameTimes(segments, fps);
    // Pixi uploads a decoded `VideoFrame` directly (canvas paint only for
    // rotated samples — see `frameSurface`).
    const reader =
      sequential?.begin(frameTimes, { mode: "video-frame" }) ?? null;
    const encodeQueue = new AdaptiveEncodeQueue(width, height, fps);
    const progress = throttledProgress(frameTimes.length);
    console.info(
      `[export] webm render loop: path=${reader ? "sequential" : "seek"} ` +
        `compositor=${backend} frames=${frameTimes.length} ` +
        `codec=${tuning.codec} latency=${tuning.latencyMode} ` +
        `hw=${tuning.hardwareAcceleration} ` +
        `audio=${audioMuxed ? "in-container" : "post-mux"} ` +
        `encodeDepthSeed=${encodeQueue.depth}`,
    );
    let driftLogs = 0;
    let framesDone = 0;
    let timestamp = 0;
    let yields = 0;
    const loopStart = performance.now();
    let lastYieldAt = loopStart;

    for (const t of frameTimes) {
      throwIfAborted(signal);
      if (reader) {
        await reader.nextFrame();
      } else {
        await seekTo(video, t);
        if (camera) {
          const camT = faceCamMediaTime(t, faceCam.offsetMs, camera.duration);
          if (camT != null) await seekTo(camera, camT).catch(() => undefined);
        }
        // Cheap freeze detector: a seek that lands far from the target means the
        // element stopped honoring seeks (the fragmented-MP4 clamp signature).
        if (Math.abs(video.currentTime - t) > 0.1 && driftLogs < 10) {
          driftLogs += 1;
          console.warn(
            `[export] webm seek clamp at frame ${framesDone}: wanted ${t.toFixed(3)}s ` +
              `got ${video.currentTime.toFixed(3)}s`,
          );
        }
      }
      const composeStart = performance.now();
      throwIfGpuLost(isGpuLost);
      drawAt(t);
      throwIfGpuLost(isGpuLost);
      const frameComposeMs = performance.now() - composeStart;

      // `add()` snapshots the surface into a VideoFrame synchronously, so the
      // compositor is free to redraw while the encode completes.
      const encoded = source.add(timestamp, frameDuration);
      // Deadline: `push` only blocks when the queue is at depth, and then only
      // on a real encode. Eight seconds for one frame means the encoder is gone.
      await withDeadline(
        encodeQueue.push(encoded, frameComposeMs),
        ENCODE_STALL_MS,
        "webm encode backpressure",
      );
      timestamp += frameDuration;
      framesDone += 1;
      progress(framesDone);

      // Hand the main thread back if we have held it too long. The frame clock
      // is precomputed (`planFrameTimes`), so pausing here cannot change which
      // source frame lands in which output frame — only whether the window
      // repaints while it happens.
      const decision = shouldYieldNow(performance.now(), lastYieldAt);
      if (decision.shouldYield) {
        yields += 1;
        await yieldToMain();
        lastYieldAt = performance.now();
        throwIfAborted(signal);
      }
    }
    await withDeadline(encodeQueue.drain(), FLUSH_STALL_MS, "webm encode drain");
    await withDeadline(audioPump, FLUSH_STALL_MS, "webm audio pump");
    const wallMs = performance.now() - loopStart;
    const uploads = uploadStats();
    console.info(
      `[export] webm render loop done in ${(wallMs / 1000).toFixed(1)}s ` +
        `(${(framesDone / (wallMs / 1000)).toFixed(1)} fps) — ` +
        `yields=${yields}` +
        (uploads
          ? `, uploads=${uploads.uploads} skipped=${uploads.skipped}`
          : ""),
    );
    const breakdown = stats();
    if (breakdown) console.info(`[export] composite breakdown: ${breakdown}`);

    await withDeadline(output.finalize(), FLUSH_STALL_MS, "webm finalize");
    if (sink.bytesWritten < 256) {
      throw new Error(
        "export produced an empty video — try again or use a longer clip",
      );
    }
    return audioMuxed;
  } catch (e) {
    // Release the encoder on failure; finalize() is what normally closes it.
    if (output.state === "started")
      await output.cancel().catch(() => undefined);
    throw e;
  } finally {
    audioTrack?.dispose();
    dispose();
  }
}

async function notifyDone(location: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: "Export finished", body: location });
  } catch {
    /* notifications are best-effort */
  }
  try {
    await revealItemInDir(location);
  } catch {
    /* reveal is best-effort */
  }
}

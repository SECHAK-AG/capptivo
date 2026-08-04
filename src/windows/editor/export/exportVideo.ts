/**
 * Export: composite the timeline to MP4/WebM/GIF.
 *
 * MP4 prefers Pixi compose → WebCodecs Annex-B H.264 → Rust ffmpeg `-c copy`
 * (Recordly breeze shape: compressed IPC, no RGBA pipe). RGBA → ffmpeg
 * re-encode is opt-in / last-resort. WebM uses mediabunny in-webview mux; GIF
 * uses gifenc. Windows never falls through to in-webview MP4 mux. Export media
 * is loaded as blob: URLs so the canvas is not tainted by media://.
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
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type VideoCodec,
  type VideoEncodingAdditionalOptions,
} from "mediabunny";

import type { TrimSegment } from "@/engine";
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
  waitUntil,
} from "./exportCompositor";
import { openSequentialMedia } from "./sequentialMedia";
import { shouldYieldNow, yieldToMain } from "./exportYield";
import { AdaptiveEncodeQueue } from "./encodeBackpressure";
import { ExportSink } from "./exportSink";
import { openExportAudioTrack } from "./exportAudioTrack";
import { renderGifToSink } from "./exportGif";
import {
  probeAnnexBConfig,
  renderMp4ViaFfmpegH264,
} from "./exportH264Ffmpeg";
import { renderMp4ViaFfmpegRawvideo } from "./exportRawvideoFfmpeg";
import {
  shouldAllowInWebviewMp4Mux,
  shouldForceFfmpegRawvideoEncode,
  shouldTryFfmpegRawvideoFallback,
} from "./exportRouting";
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

type CanvasCaptureTrack = MediaStreamTrack & { requestFrame?: () => void };

function pickMime(prefer: "mp4" | "webm"): {
  mime: string;
  fileExt: "mp4" | "webm";
} {
  const supported = (m: string) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m);
  const preferred =
    prefer === "mp4"
      ? [
          "video/mp4;codecs=avc1.42E01E",
          "video/mp4",
          "video/webm;codecs=vp9",
          "video/webm",
        ]
      : [
          "video/webm;codecs=vp9",
          "video/webm",
          "video/mp4;codecs=avc1.42E01E",
          "video/mp4",
        ];
  for (const mime of preferred) {
    if (supported(mime)) {
      return { mime, fileExt: mime.startsWith("video/mp4") ? "mp4" : "webm" };
    }
  }
  return { mime: "", fileExt: prefer };
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

/** MediaRecorder fallback may only support WebM — never write those bytes to `.mp4`. */
function alignExportPathExtension(
  path: string,
  ext: "mp4" | "webm",
): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot <= lastSlash) return `${path}.${ext}`;
  return `${path.slice(0, dot)}.${ext}`;
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
  // encoded video. Cancelling here also skips all render work.
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
    let exportPath = path;
    if (resolved.format !== "gif") {
      const tuning =
        typeof VideoEncoder !== "undefined"
          ? await pickVideoEncodeTuning(
              codecCandidates(resolved.container),
              resolved.width,
              resolved.height,
              resolved.bitrate,
            )
          : null;
      if (!tuning) {
        const { fileExt } = pickMime(resolved.container);
        exportPath = alignExportPathExtension(path, fileExt);
      }
    }
    throwIfAborted(signal);

    if (resolved.format === "gif") {
      sink = await ExportSink.open(exportPath);
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

    const finishVideoOnly = async (videoPath: string) => {
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

    // MP4: Annex-B → ffmpeg `-c copy` first (compressed IPC). RGBA Path B only
    // when forced or as native escape hatch. Windows never enters in-webview
    // MP4 mux — that path is the documented WebView2 failure mode.
    const forceRawvideo =
      resolved.container === "mp4" &&
      shouldForceFfmpegRawvideoEncode(
        import.meta.env.VITE_CAPPTIVO_RAWVIDEO_EXPORT === "1",
      );
    let mp4NativeDone = false;
    let lastNativeError: unknown = null;

    const tryRawvideo = async (why: string) => {
      console.info(`[export] path=ffmpeg-rawvideo (${why})`);
      try {
        await renderMp4ViaFfmpegRawvideo(
          exportPath,
          screenUrl,
          faceCam,
          resolved,
          signal,
        );
        throwIfAborted(signal);
        await finishVideoOnly(exportPath);
        mp4NativeDone = true;
      } catch (e) {
        if (isExportCancelled(e) || isGpuContextLostError(e)) throw e;
        lastNativeError = e;
        console.warn(
          `[export] ffmpeg-rawvideo failed (${describeError(e)}); falling back`,
        );
        logClientError("export:ffmpeg-rawvideo", e);
      }
    };

    if (forceRawvideo) {
      await tryRawvideo("forced via VITE_CAPPTIVO_RAWVIDEO_EXPORT");
    }

    if (resolved.container === "mp4" && !mp4NativeDone) {
      const annexBTuning = await probeAnnexBConfig(
        resolved.width,
        resolved.height,
        resolved.bitrate,
        resolved.fps,
      );

      if (annexBTuning) {
        console.info("[export] path=ffmpeg-h264-stream (mux outside WebView)");
        try {
          await renderMp4ViaFfmpegH264(
            exportPath,
            screenUrl,
            faceCam,
            resolved,
            signal,
            annexBTuning,
          );
          throwIfAborted(signal);
          await finishVideoOnly(exportPath);
          mp4NativeDone = true;
        } catch (e) {
          if (isExportCancelled(e) || isGpuContextLostError(e)) throw e;
          lastNativeError = e;
          console.warn(
            `[export] ffmpeg-h264 failed (${describeError(e)}); trying native fallback`,
          );
          logClientError("export:ffmpeg-h264", e);
        }
      }

      if (
        !mp4NativeDone &&
        shouldTryFfmpegRawvideoFallback(forceRawvideo)
      ) {
        await tryRawvideo(
          annexBTuning
            ? "Annex-B failed; RGBA encode escape hatch"
            : "Annex-B unavailable; RGBA encode escape hatch",
        );
      }

      if (mp4NativeDone) return;

      if (!shouldAllowInWebviewMp4Mux(isWindows)) {
        throw lastNativeError instanceof Error
          ? lastNativeError
          : new Error(
              lastNativeError
                ? describeError(lastNativeError)
                : "MP4 export failed: no working native encoder path on Windows",
            );
      }
    }

    if (mp4NativeDone) return;

    sink = await ExportSink.open(exportPath);
    const audioMuxed = await renderVideoToSink(
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

    // In-container mux succeeded → skip the rewrite. Otherwise fall back to
    // FFmpeg attach (or the classic one-shot mux if prepare also failed).
    if (!audioMuxed) {
      if (prepared) {
        store.setExportStatus(translateNow("export.status.addingAudio"));
        await commands
          .attachExportAudio({
            videoPath: saved,
            audioPath: prepared.absPath,
          })
          .catch(async (e) => {
            console.warn("export audio attach failed; trying full mux", e);
            await muxRecordedAudio(saved, settings.audioEnhance);
          });
      } else {
        await muxRecordedAudio(saved, settings.audioEnhance).catch((e) =>
          console.warn("export audio mux failed; keeping silent video", e),
        );
      }
    }

    await notifyDone(saved);
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
  });
  if (!absPath) return null;
  if (preset !== "off") {
    console.info(
      `[export] audio enhance=${preset} systemAudio=${project.capture.capturedSystemAudio}`,
    );
  }
  return { absPath, mediaUrl: mediaUrl(project.id, outName) };
}

/**
 * Progress writes go through the store, which re-renders the export UI. At 60
 * fps over a few minutes that is tens of thousands of React renders competing
 * with the encode loop for the main thread, for a bar that moves in percent.
 * Report only when the rounded percentage actually changes.
 */
function throttledProgress(totalFrames: number): (framesDone: number) => void {
  let lastPercent = -1;
  return (framesDone) => {
    const ratio = Math.min(1, framesDone / Math.max(1, totalFrames));
    const percent = Math.round(ratio * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    useEditorStore.getState().setExportProgress(ratio);
  };
}

/** Codec preference per container — first the browser can encode at size wins. */
function codecCandidates(container: "mp4" | "webm"): VideoCodec[] {
  return container === "webm" ? ["vp9", "av1", "vp8"] : ["avc", "hevc"];
}

/** Keyframe spacing: fewer I-frames → less encoder work at the same bitrate. */
const EXPORT_KEYFRAME_INTERVAL_SEC = 4;

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
 * realtime does not need to drop frames to keep up.
 */
async function pickVideoEncodeTuning(
  codecs: VideoCodec[],
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
      for (const codec of codecs) {
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
 * Deterministic export: decode each source frame, composite it, and encode it
 * via WebCodecs (mediabunny). Unlike the realtime MediaRecorder path this does
 * not depend on the machine keeping up with playback — it renders exactly
 * `fps` frames per second regardless of how long each composite takes, so the
 * output is always smooth at the chosen frame rate with no dropped frames or
 * flicker.
 *
 * Decoding is sequential (each source packet decoded once — see
 * `sequentialMedia.ts`); if that path can't initialize, per-frame `<video>`
 * seeks are the fallback with identical frame selection. Falls back to
 * MediaRecorder if the browser can't encode via WebCodecs at all.
 *
 * Encode queue depth is adaptive (`AdaptiveEncodeQueue`): seeded by output
 * megapixels and tightened at high fps, then nudged from composite vs encode
 * timing so the encoder stays fed without unbounded in-flight frames.
 */
async function renderVideoToSink(
  sink: ExportSink,
  screenUrl: string,
  faceCam: FaceCamTrack,
  params: ResolvedExportParams,
  audioMediaUrl: string | null,
  signal: AbortSignal,
): Promise<boolean> {
  const { width, height, fps, bitrate, container } = params;
  throwIfAborted(signal);

  const tuning =
    typeof VideoEncoder !== "undefined"
      ? await pickVideoEncodeTuning(
          codecCandidates(container),
          width,
          height,
          bitrate,
        )
      : null;

  if (!tuning) {
    // Old webview without WebCodecs: keep the realtime capture path working.
    // In-container audio mux needs the mediabunny Output; fall back to post-mux.
    await renderVideoViaMediaRecorder(
      sink,
      screenUrl,
      faceCam,
      pickMime(container).mime,
      params,
      signal,
    );
    return false;
  }

  throwIfAborted(signal);
  const sequential = await openSequentialMedia(screenUrl, faceCam).catch(
    () => null,
  );
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
    format:
      container === "webm"
        ? new WebMOutputFormat()
        : // `fastStart: false` writes metadata at the end — the least-memory,
          // stream-friendly layout. Paired with the positioned sink it never
          // buffers the whole file (`"in-memory"` would).
          new Mp4OutputFormat({ fastStart: false }),
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
      `[export] render loop: path=${reader ? "sequential" : "seek"} ` +
        `compositor=${backend} frames=${frameTimes.length} ` +
        `codec=${tuning.codec} latency=${tuning.latencyMode} ` +
        `hw=${tuning.hardwareAcceleration} ` +
        `audio=${audioMuxed ? "in-container" : "post-mux"} ` +
        `lastFrameTime=${frameTimes[frameTimes.length - 1]?.toFixed(3)}s ` +
        `encodeDepthSeed=${encodeQueue.depth}`,
    );
    let driftLogs = 0;
    let framesDone = 0;
    let timestamp = 0;
    let decodeMs = 0;
    let composeMs = 0;
    let captureMs = 0;
    let yields = 0;
    // Wall time the loop spends handed back to the browser. This is the whole
    // cost of running the export on the main thread — not just timer latency,
    // but whatever WebKit chooses to do in that window (paint, React, GC) —
    // and therefore the ceiling on what moving this loop into a Worker could
    // recover. Reported as a share of wall time so the question is answerable
    // from one real export instead of an A/B protocol.
    let yieldMs = 0;
    const loopStart = performance.now();
    let lastYieldAt = loopStart;

    for (const t of frameTimes) {
      throwIfAborted(signal);
      const decodeStart = performance.now();
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
            `[export] seek clamp at frame ${framesDone}: wanted ${t.toFixed(3)}s ` +
              `got ${video.currentTime.toFixed(3)}s (duration=${video.duration.toFixed(3)})`,
          );
        }
      }
      const composeStart = performance.now();
      throwIfGpuLost(isGpuLost);
      drawAt(t);
      throwIfGpuLost(isGpuLost);
      const captureStart = performance.now();
      const frameComposeMs = captureStart - composeStart;
      decodeMs += composeStart - decodeStart;
      composeMs += frameComposeMs;

      // `add()` snapshots the surface into a VideoFrame synchronously — on a
      // GPU-backed surface that is a real copy, so it gets its own bucket
      // rather than hiding inside "encode wait".
      const encoded = source.add(timestamp, frameDuration);
      captureMs += performance.now() - captureStart;
      // Awaiting happens inside the queue only when depth is hit.
      await encodeQueue.push(encoded, frameComposeMs);
      timestamp += frameDuration;
      framesDone += 1;
      progress(framesDone);

      // Hand the main thread back if we have held it too long. The frame clock
      // is precomputed (`planFrameTimes`), so pausing here cannot change which
      // source frame lands in which output frame — only whether the window
      // repaints while it happens. Timing buckets are already closed above, so
      // no yield latency is charged to decode/composite/capture.
      const decision = shouldYieldNow(performance.now(), lastYieldAt);
      if (decision.shouldYield) {
        yields += 1;
        const yieldStart = performance.now();
        await yieldToMain();
        // Measured after the await: the timer's own latency should not count
        // toward the next interval.
        lastYieldAt = performance.now();
        yieldMs += lastYieldAt - yieldStart;
        throwIfAborted(signal);
      }
    }
    await encodeQueue.drain();
    await audioPump;
    const q = encodeQueue.stats();
    const wallMs = performance.now() - loopStart;
    const uploads = uploadStats();
    console.info(
      `[export] render loop done in ${(wallMs / 1000).toFixed(1)}s ` +
        `(${(framesDone / (wallMs / 1000)).toFixed(1)} fps) — ` +
        `decode ${(decodeMs / framesDone).toFixed(1)}ms/frame, ` +
        `composite ${(composeMs / framesDone).toFixed(1)}ms/frame, ` +
        `capture ${(captureMs / framesDone).toFixed(1)}ms/frame, ` +
        `encodeWait ${q.emaEncodeWaitMs.toFixed(1)}ms/frame, depth=${q.depth}, ` +
        `yields=${yields} yieldMs=${yieldMs.toFixed(0)} ` +
        `(${((yieldMs / Math.max(1, wallMs)) * 100).toFixed(1)}% of wall)` +
        (uploads
          ? `, uploads=${uploads.uploads} skipped=${uploads.skipped}`
          : ""),
    );
    const breakdown = stats();
    if (breakdown) console.info(`[export] composite breakdown: ${breakdown}`);

    await output.finalize();
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

/** Legacy realtime capture path, used only when WebCodecs is unavailable. */
async function renderVideoViaMediaRecorder(
  sink: ExportSink,
  screenUrl: string,
  faceCam: FaceCamTrack,
  mime: string,
  params: ResolvedExportParams,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const { width, height, fps, bitrate } = params;
  // `captureStream` is a DOM-canvas API, so this path opts out of the
  // offscreen surface the WebCodecs loop uses.
  const session = await createExportCompositor(
    screenUrl,
    faceCam,
    width,
    height,
    {
      offscreen: false,
    },
  );
  const { canvas, video, camera, segments, kept, drawAt, dispose, isGpuLost } =
    session;
  if (!(canvas instanceof HTMLCanvasElement)) {
    dispose();
    throw new Error("MediaRecorder export needs a DOM canvas");
  }

  try {
    const TIMESLICE_MS = 250;
    // fps=0 + requestFrame: WebKit often muxes 0 packets with timed captureStream.
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureTrack | undefined;
    const recorder = new MediaRecorder(
      stream,
      mime
        ? { mimeType: mime, videoBitsPerSecond: bitrate }
        : { videoBitsPerSecond: bitrate },
    );
    // MediaRecorder emits sequential blobs; append each to disk in order as it
    // arrives (serialized via the chain) so we never hold the whole file.
    let writeChain: Promise<void> = Promise.resolve();
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      const blob = e.data;
      writeChain = writeChain.then(async () => {
        await sink.append(new Uint8Array(await blob.arrayBuffer()));
      });
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    let playedBefore = 0;
    let activeSeg: TrimSegment | null = null;
    const frameInterval = 1 / Math.max(1, fps);
    let lastCaptureAt = -Infinity;

    let raf = 0;
    const draw = () => {
      if (isGpuLost()) {
        cancelAnimationFrame(raf);
        raf = 0;
        return;
      }
      const t = video.currentTime;
      if (camera) {
        const target = faceCamMediaTime(t, faceCam.offsetMs, camera.duration);
        // Only hard-seek on large drift — re-seeking a playing element every
        // frame stutters the face-cam. Small drift resolves as it plays.
        if (target != null && Math.abs(camera.currentTime - target) > 0.25) {
          camera.currentTime = target;
        }
      }
      drawAt(t);
      if (t - lastCaptureAt >= frameInterval - 1e-4) {
        track?.requestFrame?.();
        lastCaptureAt = t;
      }
      if (activeSeg && kept > 0) {
        const local = Math.max(0, Math.min(activeSeg.end, t) - activeSeg.start);
        useEditorStore
          .getState()
          .setExportProgress(Math.min(1, (playedBefore + local) / kept));
      }
      raf = requestAnimationFrame(draw);
    };

    // Prime one painted frame before the recorder starts.
    throwIfGpuLost(isGpuLost);
    drawAt(segments[0]?.start ?? 0);
    track?.requestFrame?.();
    recorder.start(TIMESLICE_MS);
    raf = requestAnimationFrame(draw);

    for (const seg of segments) {
      throwIfAborted(signal);
      activeSeg = seg;
      await seekTo(video, seg.start);
      if (camera) {
        const camT = faceCamMediaTime(
          seg.start,
          faceCam.offsetMs,
          camera.duration,
        );
        if (camT != null) await seekTo(camera, camT).catch(() => undefined);
      }
      await video.play();
      if (camera) void camera.play().catch(() => undefined);
      await waitUntil(
        video,
        () =>
          signal.aborted ||
          isGpuLost() ||
          video.currentTime >= seg.end - 1 / fps ||
          video.ended,
      );
      throwIfAborted(signal);
      throwIfGpuLost(isGpuLost);
      video.pause();
      camera?.pause();
      playedBefore += Math.max(0, seg.end - seg.start);
    }

    cancelAnimationFrame(raf);
    throwIfGpuLost(isGpuLost);
    drawAt(segments[segments.length - 1]?.end ?? video.currentTime);
    track?.requestFrame?.();
    if (recorder.state === "recording") recorder.requestData();
    recorder.stop();
    await stopped;
    await writeChain; // flush any writes still queued from the final blobs

    if (sink.bytesWritten < 256) {
      throw new Error(
        "export produced an empty video — try again or use a longer clip",
      );
    }
  } finally {
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

/**
 * Export: composite timeline to MP4/WebM (WebCodecs) or GIF.
 * Media loads as blob: URLs so the canvas stays untainted for GPU readback.
 */

import { save } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
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
import { mediaUrl } from "@/lib/platform";
import { commands } from "../../../ipc/bindings";
import { describeError } from "../../recorder/store";
import { useEditorStore } from "../store";
import {
  createExportCompositor,
  createExportCompositorFromMedia,
  planFrameTimes,
  seekTo,
  waitUntil,
  yieldToMain,
} from "./exportCompositor";
import { openSequentialMedia } from "./sequentialMedia";
import { shouldYieldNow } from "./exportYield";
import { AdaptiveEncodeQueue } from "./encodeBackpressure";
import { ExportSink } from "./exportSink";
import { openExportAudioTrack } from "./exportAudioTrack";
import { renderGifToSink } from "./exportGif";
import {
  DEFAULT_EXPORT_SETTINGS,
  resolveExportParams,
  type ExportAudioEnhance,
  type ExportSettings,
  type ResolvedExportParams,
} from "./exportSettings";
import { resolveStageSize } from "../lib/composition";

type CanvasCaptureTrack = MediaStreamTrack & { requestFrame?: () => void };

function pickMime(prefer: "mp4" | "webm"): { mime: string; fileExt: "mp4" | "webm" } {
  const supported = (m: string) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m);
  const preferred =
    prefer === "mp4"
      ? ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"]
      : ["video/webm;codecs=vp9", "video/webm", "video/mp4;codecs=avc1.42E01E", "video/mp4"];
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

export async function exportProject(
  settings: ExportSettings = DEFAULT_EXPORT_SETTINGS,
): Promise<void> {
  const store = useEditorStore.getState();
  const { project, screenUrl, sourceVideoSize } = store;
  if (!project || !screenUrl || !sourceVideoSize) return;

  const stage = resolveStageSize(
    store.aspectRatioPresetId,
    sourceVideoSize,
  );
  const resolved = resolveExportParams(settings, stage.width, stage.height);
  const fileExt = resolved.ext;
  const base = (project.title ?? "recording").replace(/[^\w.-]+/g, "-") || "recording";
  const suggestedName = `${base}.${fileExt}`;

  store.setExporting(true);
  store.setExportError(null);

  let path: string | null = null;
  try {
    store.setExportStatus("Choose where to save…");
    path = await pickSavePath(suggestedName, fileExt);
  } catch (e) {
    store.setExportError(describeError(e));
  }
  if (!path) {
    const s = useEditorStore.getState();
    s.setExporting(false);
    s.setExportStatus(null);
    return;
  }

  store.setExportStatus(resolved.format === "gif" ? "Rendering GIF…" : "Rendering your file.");
  let sink: ExportSink | null = null;
  let audioPrep: Promise<PreparedExportAudio | null> | null = null;
  let audioAbsPath: string | null = null;
  try {
    if (resolved.format !== "gif") {
      const outName = `capptivo-export-audio-${crypto.randomUUID()}.${
        resolved.container === "webm" ? "webm" : "m4a"
      }`;
      audioPrep = prepareExportAudioTrack(outName, settings.audioEnhance).catch((e) => {
        console.warn("export audio prepare failed; will fall back to post-mux", e);
        return null;
      });
    }

    await commands.ensureSeekableRecording(project.id);
    sink = await ExportSink.open(path);

    if (resolved.format === "gif") {
      await renderGifToSink(sink, screenUrl, store.cameraUrl, resolved);
    } else {
      const prepared = audioPrep ? await audioPrep : null;
      audioAbsPath = prepared?.absPath ?? null;
      const audioMuxed = await renderVideoToSink(
        sink,
        screenUrl,
        store.cameraUrl,
        resolved,
        prepared?.mediaUrl ?? null,
      );
      store.setExportStatus("Saving…");
      const saved = await sink.finish();
      sink = null;

      if (!audioMuxed) {
        if (prepared) {
          store.setExportStatus("Adding audio…");
          await commands
            .attachExportAudio({ videoPath: saved, audioPath: prepared.absPath })
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
      return;
    }
    store.setExportStatus("Saving…");
    const saved = await sink.finish();
    await notifyDone(saved);
  } catch (e) {
    await sink?.abort(e);
    useEditorStore.getState().setExportError(describeError(e));
  } finally {
    if (!audioAbsPath && audioPrep) {
      const leftover = await audioPrep.catch(() => null);
      audioAbsPath = leftover?.absPath ?? null;
    }
    if (audioAbsPath) {
      void commands.removeTempFile({ path: audioAbsPath }).catch(() => undefined);
    }
    const s = useEditorStore.getState();
    s.setExporting(false);
    s.setExportProgress(0);
    s.setExportStatus(null);
  }
}

/** Mux recorded audio into the saved video (FFmpeg, `-c:v copy`). */
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

  useEditorStore.getState().setExportStatus("Adding audio…");
  await commands.muxExportAudio({
    projectId: project.id,
    videoPath,
    audioSource: project.files.screen,
    segments: kept,
    preset,
    hasSystemAudio: project.capture.capturedSystemAudio,
  });
}

/** Trim/enhance audio to a sidecar file; returns paths or `null` if silent. */
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

/** Throttle progress updates to rounded-percent changes only. */
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

/** Keyframe spacing — fewer I-frames at the same bitrate. */
const EXPORT_KEYFRAME_INTERVAL_SEC = 4;

type VideoEncodeTuning = {
  codec: VideoCodec;
  latencyMode: NonNullable<VideoEncodingAdditionalOptions["latencyMode"]>;
  hardwareAcceleration: NonNullable<VideoEncodingAdditionalOptions["hardwareAcceleration"]>;
};

/** Pick fastest supported encoder config (hardware + realtime preferred). */
async function pickVideoEncodeTuning(
  codecs: VideoCodec[],
  width: number,
  height: number,
  bitrate: number,
): Promise<VideoEncodeTuning | null> {
  const hardwareModes: NonNullable<VideoEncodingAdditionalOptions["hardwareAcceleration"]>[] = [
    "prefer-hardware",
    "no-preference",
    "prefer-software",
  ];
  const latencyModes: NonNullable<VideoEncodingAdditionalOptions["latencyMode"]>[] = [
    "realtime",
    "quality",
  ];

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
 * Deterministic WebCodecs export: decode each frame, composite, encode at fixed fps.
 * Sequential decode when available; per-frame seek fallback; MediaRecorder last resort.
 */
async function renderVideoToSink(
  sink: ExportSink,
  screenUrl: string,
  cameraUrl: string | null,
  params: ResolvedExportParams,
  audioMediaUrl: string | null,
): Promise<boolean> {
  const { width, height, fps, bitrate, container } = params;

  const tuning =
    typeof VideoEncoder !== "undefined"
      ? await pickVideoEncodeTuning(codecCandidates(container), width, height, bitrate)
      : null;

  if (!tuning) {
    await renderVideoViaMediaRecorder(sink, screenUrl, cameraUrl, pickMime(container).mime, params);
    return false;
  }

  const sequential = await openSequentialMedia(screenUrl, cameraUrl).catch(() => null);
  const session = sequential
    ? await createExportCompositorFromMedia(sequential.media, width, height)
    : await createExportCompositor(screenUrl, cameraUrl, width, height);
  const { canvas, video, camera, segments, drawAt, dispose, backend, stats, uploadStats } =
    session;

  const output = new Output({
    format:
      container === "webm"
        ? new WebMOutputFormat()
        : new Mp4OutputFormat({ fastStart: false }),
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
    const loopStart = performance.now();
    let lastYieldAt = loopStart;

    for (const t of frameTimes) {
      const decodeStart = performance.now();
      if (reader) {
        await reader.nextFrame();
      } else {
        await seekTo(video, t);
        if (camera) await seekTo(camera, t).catch(() => undefined);
        if (Math.abs(video.currentTime - t) > 0.1 && driftLogs < 10) {
          driftLogs += 1;
          console.warn(
            `[export] seek clamp at frame ${framesDone}: wanted ${t.toFixed(3)}s ` +
              `got ${video.currentTime.toFixed(3)}s (duration=${video.duration.toFixed(3)})`,
          );
        }
      }
      const composeStart = performance.now();
      drawAt(t);
      const captureStart = performance.now();
      const frameComposeMs = captureStart - composeStart;
      decodeMs += composeStart - decodeStart;
      composeMs += frameComposeMs;

      const encoded = source.add(timestamp, frameDuration);
      captureMs += performance.now() - captureStart;
      await encodeQueue.push(encoded, frameComposeMs);
      timestamp += frameDuration;
      framesDone += 1;
      progress(framesDone);

      const decision = shouldYieldNow(performance.now(), lastYieldAt);
      if (decision.shouldYield) {
        yields += 1;
        await yieldToMain();
        lastYieldAt = performance.now();
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
        `yields=${yields}` +
        (uploads
          ? `, uploads=${uploads.uploads} skipped=${uploads.skipped}`
          : ""),
    );
    const breakdown = stats();
    if (breakdown) console.info(`[export] composite breakdown: ${breakdown}`);

    await output.finalize();
    if (sink.bytesWritten < 256) {
      throw new Error("export produced an empty video — try again or use a longer clip");
    }
    return audioMuxed;
  } catch (e) {
    if (output.state === "started") await output.cancel().catch(() => undefined);
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
  cameraUrl: string | null,
  mime: string,
  params: ResolvedExportParams,
): Promise<void> {
  const { width, height, fps, bitrate } = params;
  const session = await createExportCompositor(screenUrl, cameraUrl, width, height, {
    offscreen: false,
  });
  const { canvas, video, camera, segments, kept, drawAt, dispose } = session;
  if (!(canvas instanceof HTMLCanvasElement)) {
    dispose();
    throw new Error("MediaRecorder export needs a DOM canvas");
  }

  try {
    const TIMESLICE_MS = 250;
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureTrack | undefined;
    const recorder = new MediaRecorder(
      stream,
      mime
        ? { mimeType: mime, videoBitsPerSecond: bitrate }
        : { videoBitsPerSecond: bitrate },
    );
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
      const t = video.currentTime;
      if (camera && Number.isFinite(camera.duration) && camera.duration > 0) {
        const target = Math.min(t, Math.max(0, camera.duration - 0.001));
        if (Math.abs(camera.currentTime - target) > 0.25) camera.currentTime = target;
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

    // Prime one frame before recording starts.
    drawAt(segments[0]?.start ?? 0);
    track?.requestFrame?.();
    recorder.start(TIMESLICE_MS);
    raf = requestAnimationFrame(draw);

    for (const seg of segments) {
      activeSeg = seg;
      await seekTo(video, seg.start);
      if (camera) await seekTo(camera, seg.start).catch(() => undefined);
      await video.play();
      if (camera) void camera.play().catch(() => undefined);
      await waitUntil(video, () => video.currentTime >= seg.end - 1 / fps || video.ended);
      video.pause();
      camera?.pause();
      playedBefore += Math.max(0, seg.end - seg.start);
    }

    cancelAnimationFrame(raf);
    drawAt(segments[segments.length - 1]?.end ?? video.currentTime);
    track?.requestFrame?.();
    if (recorder.state === "recording") recorder.requestData();
    recorder.stop();
    await stopped;
    await writeChain;

    if (sink.bytesWritten < 256) {
      throw new Error("export produced an empty video — try again or use a longer clip");
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

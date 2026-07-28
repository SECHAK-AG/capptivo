/**
 * Face-cam file capture inside the camera bubble WebView.
 *
 * On `camera://capture-start` we re-open getUserMedia (a stream opened before
 * ScreenCaptureKit often goes black). Preview stays in this same window at the
 * same size/position — no HUD handoff.
 */

import { emit, listen } from "@tauri-apps/api/event";
import { commands } from "@/ipc/bindings";

const CAPTURE_START = "camera://capture-start";
const CAPTURE_FLUSH = "camera://capture-flush";
const CAPTURE_FLUSHED = "camera://capture-flushed";

type PreviewApi = {
  getDeviceId: () => string | null;
  getVideo: () => HTMLVideoElement | null;
  /** Stop current tracks and open a fresh preview stream for `deviceId`. */
  reopen: (deviceId: string) => Promise<MediaStream | null>;
};

let api: PreviewApi | null = null;
let recorder: MediaRecorder | null = null;
let subscribed = false;
/**
 * Serializes chunk writes to the Rust sink. `Blob.arrayBuffer()` is async, so
 * writing each `ondataavailable` chunk fire-and-forget lets them land on disk
 * out of order and corrupts the streamed WebM — the file then fails to decode
 * in the editor and the face-cam disappears. Chaining keeps them in order and
 * gives us a single promise to await on flush.
 */
let writeChain: Promise<void> = Promise.resolve();

function enqueueChunk(blob: Blob): void {
  writeChain = writeChain.then(async () => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    await commands.writeCameraChunk(buf).catch(() => undefined);
  });
}

function pickRecorderMime(): { mime: string; filename: "camera.webm" | "camera.mp4" } {
  if (typeof MediaRecorder === "undefined") {
    return { mime: "", filename: "camera.webm" };
  }
  for (const [mime, filename] of [
    ["video/webm;codecs=vp9", "camera.webm"],
    ["video/webm;codecs=vp8", "camera.webm"],
    ["video/webm", "camera.webm"],
    ["video/mp4", "camera.mp4"],
  ] as const) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, filename };
  }
  return { mime: "", filename: "camera.webm" };
}

export function bindCameraCaptureApi(next: PreviewApi | null) {
  api = next;
}

async function startCapture(projectId: string) {
  if (recorder && recorder.state !== "inactive") return;
  const deviceId = api?.getDeviceId();
  if (!deviceId || !api) {
    await emit(CAPTURE_FLUSHED, null);
    return;
  }

  // Fresh stream after SCK starts — pre-SCK tracks go black in this WebView.
  const stream = await api.reopen(deviceId);
  const video = api.getVideo();
  if (!stream || !video) {
    await emit(CAPTURE_FLUSHED, null);
    return;
  }

  const { mime, filename } = pickRecorderMime();
  if (!mime) {
    await emit(CAPTURE_FLUSHED, null);
    return;
  }

  try {
    await commands.beginCameraFile(projectId, filename);
    writeChain = Promise.resolve();
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 2_500_000,
    });
    recorder = rec;
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) enqueueChunk(ev.data);
    };
    rec.start(250);
  } catch {
    recorder = null;
    await commands.finishCameraFile().catch(() => null);
    await emit(CAPTURE_FLUSHED, null);
  }
}

async function flushCapture() {
  const rec = recorder;
  if (!rec || rec.state === "inactive") {
    recorder = null;
    await commands.finishCameraFile().catch(() => null);
    await emit(CAPTURE_FLUSHED, null);
    return;
  }
  await new Promise<void>((resolve) => {
    rec.addEventListener("stop", () => resolve(), { once: true });
    try {
      rec.requestData();
    } catch {
      /* ignore */
    }
    try {
      rec.stop();
    } catch {
      resolve();
    }
  });
  recorder = null;
  // Wait for every queued chunk (including the final one from stop()) to be
  // written in order before closing the file — no fixed-sleep guesswork.
  await writeChain;
  await commands.finishCameraFile().catch(() => null);
  await emit(CAPTURE_FLUSHED, null);
}

export function ensureCameraCaptureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  void listen<string>(CAPTURE_START, (e) => {
    if (e.payload) void startCapture(e.payload);
  });
  void listen(CAPTURE_FLUSH, () => {
    void flushCapture();
  });
}

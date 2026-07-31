/** Microphone capture in the recorder WebView — warm stream + `mic.webm` during recording. */

import { listen, emit } from "@tauri-apps/api/event";
import { commands } from "@/ipc/bindings";

const CAPTURE_START = "mic://capture-start";
const CAPTURE_FLUSH = "mic://capture-flush";
const CAPTURE_FLUSHED = "mic://capture-flushed";

/** WebRTC voice processing off — on macOS, echo cancellation ducks other apps' audio. */
export const MIC_AUDIO_PROCESSING_OFF = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

/** One-shot mic TCC prompt when `enumerateDevices` returns nothing until permission is granted. */
export async function probeMicPermission(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...MIC_AUDIO_PROCESSING_OFF },
      video: false,
    });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

let warmDeviceId: string | null = null;
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let subscribed = false;
/** Serializes chunk writes so async `arrayBuffer()` can't reorder WebM chunks on disk. */
let writeChain: Promise<void> = Promise.resolve();

function enqueueChunk(blob: Blob): void {
  writeChain = writeChain.then(async () => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    await commands.writeMicChunk(buf).catch(() => undefined);
  });
}

function pickAudioMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const mime of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

/** Returns true when a new getUserMedia session was opened. */
export async function prepareMic(deviceId: string): Promise<boolean> {
  if (warmDeviceId === deviceId && stream?.active) return false;
  releaseMic();
  const next = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      ...MIC_AUDIO_PROCESSING_OFF,
    },
    video: false,
  });
  warmDeviceId = deviceId;
  stream = next;
  return true;
}

export function releaseMic(): void {
  const rec = recorder;
  if (rec && rec.state !== "inactive") {
    try {
      rec.stop();
    } catch {
      /* ignore */
    }
  }
  recorder = null;
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
  }
  stream = null;
  warmDeviceId = null;
}

/**
 * Mute/unmute without tearing down MediaRecorder — silence is written while
 * muted; re-enable resumes audio in the same `mic.webm`. Returns false when
 * there is no live stream (mic was never armed for this take).
 */
export function setMicTrackEnabled(enabled: boolean): boolean {
  if (!stream) return false;
  let any = false;
  for (const t of stream.getAudioTracks()) {
    t.enabled = enabled;
    any = true;
  }
  return any;
}

export function micTrackLive(): boolean {
  return !!stream?.active && stream.getAudioTracks().length > 0;
}

async function startMicFileCapture(projectId: string): Promise<void> {
  if (!stream || recorder) return;
  const mime = pickAudioMime();
  if (!mime) return;

  await commands.beginMicFile(projectId, "mic.webm");
  writeChain = Promise.resolve();
  const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128_000 });
  recorder = rec;
  rec.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) enqueueChunk(ev.data);
  };
  rec.start(500);
}

async function flushMicFileCapture(): Promise<void> {
  const rec = recorder;
  if (!rec || rec.state === "inactive") {
    await commands.finishMicFile().catch(() => null);
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
  await writeChain;
  await commands.finishMicFile().catch(() => null);
}

export function ensureMicCaptureListeners(): void {
  if (subscribed) return;
  subscribed = true;
  void listen<string>(CAPTURE_START, (e) => {
    if (e.payload) void startMicFileCapture(e.payload);
  });
  void listen(CAPTURE_FLUSH, () => {
    void flushMicFileCapture().then(() => emit(CAPTURE_FLUSHED, null));
  });
}

export async function flushMicCaptureWithTimeout(ms = 4000): Promise<void> {
  let unlisten: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      void listen(CAPTURE_FLUSHED, finish).then((un) => {
        unlisten = un;
        if (settled) {
          un();
          return;
        }
        void commands.flushMicCapture().catch(finish);
      });
    });
  } finally {
    unlisten?.();
  }
}

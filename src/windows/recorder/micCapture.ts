/**
 * Microphone capture in the recorder WebView (same pattern as the camera window).
 * Keeps a warm getUserMedia stream while a device is selected; MediaRecorder writes
 * `mic.webm` during recording. Rust muxes it into `screen.mp4` on stop.
 */

import { listen, emit } from "@tauri-apps/api/event";
import { commands } from "@/ipc/bindings";

const CAPTURE_START = "mic://capture-start";
const CAPTURE_FLUSH = "mic://capture-flush";
const CAPTURE_FLUSHED = "mic://capture-flushed";

/**
 * Capture the mic raw, with WebRTC voice processing OFF. On macOS,
 * `echoCancellation` routes the input through the Voice-Processing I/O audio
 * unit, which macOS treats like a VoIP call and **ducks every other app's
 * audio** — that's what quiets Chrome/music while recording and mangles the
 * system-audio track. `autoGainControl` also pumps recording levels. A screen
 * recorder wants the unprocessed signal anyway.
 */
export const MIC_AUDIO_PROCESSING_OFF = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

/**
 * Trigger the OS mic permission prompt without keeping a capture session.
 * Needed when `enumerateDevices` returns nothing until TCC is granted
 * (chicken-and-egg: menu can't list devices, so the user can't pick one to
 * call getUserMedia). Stops tracks immediately; processing stays off so we
 * don't duck other apps during the probe.
 */
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
/** Serializes chunk writes so async `arrayBuffer()` resolution can't reorder
 *  them on disk and corrupt the WebM (which would then fail the ffmpeg mux). */
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
  // Drain all queued chunks in order before closing — replaces the fixed sleep.
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
      // Listen before emitting the flush so a fast flush can't beat us to it.
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

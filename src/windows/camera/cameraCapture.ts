/**
 * Face-cam file capture in the camera bubble WebView.
 *
 * 1. **Arm** during countdown — `getUserMedia` + inactive `MediaRecorder`.
 * 2. **Start** only after native screen capture is live.
 * 3. Stamp `markCameraStarted` → offset = camStart − screenEpoch.
 *
 * Opening the file sink is fire-and-forget after `rec.start()`; chunks queue
 * behind it so the clock stamp stays tight.
 */

import { emit, listen } from "@tauri-apps/api/event";
import { commands } from "@/ipc/bindings";

const CAPTURE_ARM = "camera://capture-arm";
const CAPTURE_START = "camera://capture-start";
const CAPTURE_FLUSH = "camera://capture-flush";
const CAPTURE_FLUSHED = "camera://capture-flushed";

/** Chunk cadence. Lower = tighter A/V head sync; still room for the sink to open. */
const TIMESLICE_MS = 100;

type PreviewApi = {
  getDeviceId: () => string | null;
  getVideo: () => HTMLVideoElement | null;
  /**
   * Live preview stream for `deviceId`, opening one only if the current stream
   * is dead. Never force a fresh `getUserMedia` on the record path: it costs
   * hundreds of milliseconds of face-cam and drops the bubble to black.
   */
  ensureStream: (deviceId: string) => Promise<MediaStream | null>;
};

/** A built-but-not-started recorder, plus the file it will be written to. */
type ArmedCapture = {
  recorder: MediaRecorder;
  filename: "camera.webm" | "camera.mp4";
};

let api: PreviewApi | null = null;
let armed: ArmedCapture | null = null;
let recorder: MediaRecorder | null = null;
let subscribed = false;
/** Serializes chunk writes so async `arrayBuffer()` can't reorder WebM chunks on disk. */
let writeChain: Promise<void> = Promise.resolve();

function enqueueChunk(blob: Blob): void {
  writeChain = writeChain.then(async () => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    await commands.writeCameraChunk(buf).catch(() => undefined);
  });
}

function pickRecorderMime(): {
  mime: string;
  filename: "camera.webm" | "camera.mp4";
} {
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
  // A rebind means the preview remounted; the armed recorder points at a stream
  // that no longer exists.
  armed = null;
}

/**
 * Build the recorder without starting it. Idempotent, and safe to call when no
 * recording follows — an armed-but-unstarted `MediaRecorder` holds no file and
 * writes nothing.
 */
async function armCapture(): Promise<ArmedCapture | null> {
  if (recorder && recorder.state !== "inactive") return null;
  if (armed) return armed;

  const deviceId = api?.getDeviceId();
  if (!deviceId || !api) return null;

  const stream = await api.ensureStream(deviceId);
  if (!stream) return null;

  const { mime, filename } = pickRecorderMime();
  if (!mime) return null;

  try {
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 2_500_000,
    });
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) enqueueChunk(ev.data);
    };
    armed = { recorder: rec, filename };
    return armed;
  } catch {
    armed = null;
    return null;
  }
}

async function startCapture(projectId: string) {
  if (recorder && recorder.state !== "inactive") return;

  // Normally already armed by the countdown. Arming here is the fallback for a
  // take with no countdown, and pays the acquisition cost on the record path.
  const ready = armed ?? (await armCapture());
  if (!ready) {
    await emit(CAPTURE_FLUSHED, null);
    return;
  }
  armed = null;

  const { recorder: rec, filename } = ready;
  try {
    // Nothing may sit between here and the clock stamp below.
    rec.start(TIMESLICE_MS);
    recorder = rec;
  } catch {
    recorder = null;
    await emit(CAPTURE_FLUSHED, null);
    return;
  }
  // Fire-and-forget by design: the stamp is taken when Rust receives this, and
  // awaiting it would only delay the file open behind it.
  void commands.markCameraStarted().catch(() => undefined);

  // The sink opens in parallel with the first timeslice. Chunks queue behind it
  // rather than racing it, so ordering holds even if the open is slow.
  const sinkReady = commands.beginCameraFile(projectId, filename);
  writeChain = sinkReady.then(
    () => undefined,
    () => {
      // No file to write into — stop cleanly instead of dropping every chunk
      // into a rejected chain for the length of the take.
      try {
        rec.stop();
      } catch {
        /* already inactive */
      }
      recorder = null;
      void emit(CAPTURE_FLUSHED, null);
    },
  );
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
  await writeChain;
  await commands.finishCameraFile().catch(() => null);
  await emit(CAPTURE_FLUSHED, null);
}

export function ensureCameraCaptureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  void listen(CAPTURE_ARM, () => {
    void armCapture();
  });
  void listen<string>(CAPTURE_START, (e) => {
    if (e.payload) void startCapture(e.payload);
  });
  void listen(CAPTURE_FLUSH, () => {
    void flushCapture();
  });
}

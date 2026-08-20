/**
 * Recorder popover store. The recorder *state machine* lives in Rust; this store
 * is a **projection** of the `recorder://…` events plus local UI selection (which
 * source, which toggles). Never keep "am I recording?" anywhere but here, fed
 * from Rust (§6).
 */

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { translateNow } from "@/lib/i18n";
import { commands } from "../../ipc/bindings";
import { onElapsed, onError, onInterrupted, onStateChanged } from "../../ipc/events";
import type {
  CaptureAreaSelection,
  CaptureDevice,
  CaptureSource,
  CaptureSourceKind,
  PermissionStatus,
  QualityPreset,
  RecorderConfig,
  RecorderState,
} from "../../ipc/types";
import { SCREEN_CAPTURE_FPS } from "./captureFps";
import { probeCameraPermission } from "./cameraAccess";
import { flushCameraCaptureWithTimeout } from "./flushCamera";
import { logClientError, logClientInfo } from "@/lib/errorLogging";

export type CaptureMode = CaptureSourceKind | "area" | "device";

/** Local capture options (everything in RecorderConfig except source id + fps). */
interface CaptureOptions {
  showCursor: boolean;
  captureSystemAudio: boolean;
  quality: QualityPreset;
}

interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

interface RecorderStore {
  // --- projected from Rust ---
  state: RecorderState;
  elapsed: number;
  lastError: string | null;

  // --- local UI ---
  permissions: PermissionStatus | null;
  sources: CaptureSource[];
  selectedSourceId: string | null;
  /** Attached iPhones / iPads. Enumerated on demand — never at boot, so we
   *  don't touch AVFoundation for users who never open the Device menu. */
  devices: CaptureDevice[];
  /** `device:{uniqueID}`. Kept apart from `selectedSourceId` so switching modes
   *  can't hand a `display:` id to the device backend, or the reverse. */
  selectedDeviceId: string | null;
  loadingDevices: boolean;
  /** Scoped to the Device menu — a phoneless Mac is not a recorder error. */
  deviceError: string | null;
  captureMode: CaptureMode;
  areaSelection: CaptureAreaSelection | null;
  options: CaptureOptions;
  loadingSources: boolean;

  cameraEnabled: boolean;
  micEnabled: boolean;
  /** Mid-take mic mute (track.enabled) — does not tear down MediaRecorder. */
  micSessionMuted: boolean;
  cameraDeviceId: string | null;
  micDeviceId: string | null;
  cameras: MediaDeviceOption[];
  microphones: MediaDeviceOption[];

  /** Ink overlay visible while recording (separate WebView — synced via events). */
  annotationVisible: boolean;

  // --- actions ---
  init: () => Promise<void>;
  refreshPermissions: () => Promise<void>;
  requestPermission: () => Promise<void>;
  refreshSources: (options?: { thumbnails?: boolean }) => Promise<void>;
  refreshDevices: () => Promise<void>;
  selectDevice: (id: string) => void;
  refreshMediaDevices: () => Promise<void>;
  /**
   * Enumerate cameras; if labels are missing, one-shot video getUserMedia once
   * per session then re-enumerate. Called when camera is enabled or its menu opens.
   */
  ensureCameraDevices: () => Promise<void>;
  /**
   * Native mic list (Rust). Never WebView getUserMedia(audio) — that blacks
   * the face-cam bubble on macOS.
   */
  ensureMicrophoneDevices: () => Promise<void>;
  requestCameraAccess: () => Promise<void>;
  setCaptureMode: (mode: CaptureMode) => void;
  pickArea: () => Promise<void>;
  /** Hide crop guide and leave area mode (Esc / dismiss). */
  clearAreaSelection: () => void;
  selectSource: (id: string) => void;
  setOption: <K extends keyof CaptureOptions>(
    key: K,
    value: CaptureOptions[K],
  ) => void;
  setCameraEnabled: (enabled: boolean) => void;
  setMicEnabled: (enabled: boolean) => void;
  /** Mute/unmute the live mic track during an active recording. */
  toggleMicMute: () => void;
  setAnnotationVisible: (visible: boolean) => void;
  setCameraDeviceId: (id: string | null) => void;
  setMicDeviceId: (id: string | null) => void;
  /**
   * Keep the selected native mic open (discarding) until Record. Soft-fail.
   */
  syncMicWarm: () => void;
  /**
   * Arm face-cam (and window prep) during countdown. Mic is native — no
   * WebView getUserMedia here. Safe to skip: `startRecording` awaits the same work.
   */
  prewarmCapture: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  togglePause: () => Promise<void>;
}

const DEFAULT_OPTIONS: CaptureOptions = {
  showCursor: true,
  captureSystemAudio: false,
  quality: "balanced",
};

let subscribed = false;

/**
 * In-flight `prewarmCapture()` work, so `startRecording` can await it instead of
 * repeating it. Cleared once consumed.
 */
let prewarmInFlight: Promise<void> | null = null;

/** Unlock camera labels at most once per WebView session. */
let hasRequestedCameraLabels = false;

function rawCameras(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return devices.filter(
    (d) => d.kind === "videoinput" && !!d.deviceId && isRecorderCamera(d),
  );
}

/** Empty list (WKWebView) or devices with no labels → need a one-shot gUM. */
function needsLabelUnlock(devices: MediaDeviceInfo[]): boolean {
  if (devices.length === 0) return true;
  return devices.every((d) => !d.label.trim());
}

async function reviveCameraPreviewIfOn(
  cameraEnabled: boolean,
  cameraDeviceId: string | null,
): Promise<void> {
  if (cameraEnabled && cameraDeviceId) {
    await commands.showCameraPreview(cameraDeviceId).catch(() => undefined);
  }
}

/** macOS "Desk View" / continuity desk cameras — not useful for face-cam overlay. */
function isRecorderCamera(device: MediaDeviceInfo): boolean {
  const label = device.label.toLowerCase();
  if (label.includes("desk view") || label.includes("deskview")) return false;
  return true;
}

function pickDefaultSource(
  sources: CaptureSource[],
  mode: CaptureMode,
  currentId: string | null,
): string | null {
  if (mode !== "display" && mode !== "window") return currentId;
  const filtered = sources.filter((s) => s.kind === mode);
  if (currentId && filtered.some((s) => s.id === currentId)) return currentId;
  return filtered.find((s) => s.isPrimary)?.id ?? filtered[0]?.id ?? null;
}

/** Drop a stale area pick — guide is already torn down by Rust on dismiss/stop. */
function resetAreaCapture(
  set: (partial: {
    areaSelection: null;
    captureMode?: CaptureMode;
    selectedSourceId?: string | null;
  }) => void,
  get: () => {
    captureMode: CaptureMode;
    sources: CaptureSource[];
    selectedSourceId: string | null;
    areaSelection: CaptureAreaSelection | null;
  },
) {
  const { captureMode, sources, selectedSourceId, areaSelection } = get();
  if (!areaSelection && captureMode !== "area") return;
  if (captureMode === "area") {
    set({
      areaSelection: null,
      captureMode: "display",
      selectedSourceId: pickDefaultSource(sources, "display", selectedSourceId),
    });
  } else {
    set({ areaSelection: null });
  }
}

export const useRecorderStore = create<RecorderStore>((set, get) => {
  const reportError = (message: string) => {
    set({ lastError: message });
    logClientError("recorder", message);
  };

  return {
  state: { status: "idle" },
  elapsed: 0,
  lastError: null,

  permissions: null,
  sources: [],
  selectedSourceId: null,
  devices: [],
  selectedDeviceId: null,
  loadingDevices: false,
  deviceError: null,
  captureMode: "display",
  areaSelection: null,
  options: DEFAULT_OPTIONS,
  loadingSources: false,

  cameraEnabled: false,
  micEnabled: false,
  micSessionMuted: false,
  cameraDeviceId: null,
  micDeviceId: null,
  cameras: [],
  microphones: [],
  annotationVisible: false,

  async init() {
    if (!subscribed) {
      subscribed = true;
      await onStateChanged((state) => {
        set((prev) => {
          const nextLive =
            state.status === "recording" ||
            state.status === "paused" ||
            state.status === "finalizing";
          const prevLive =
            prev.state.status === "recording" ||
            prev.state.status === "paused" ||
            prev.state.status === "finalizing";
          // New take — zero the HUD; `Elapsed` only ticks while the encode loop runs.
          const elapsed = nextLive && !prevLive ? 0 : prev.elapsed;
          return { state, elapsed };
        });
      });
      await onElapsed((seconds) => set({ elapsed: seconds }));
      await onError((message, fatal) => {
        reportError(message);
        if (!fatal) return;
        const { state } = get();
        if (state.status !== "recording" && state.status !== "paused") return;
        // Encoding died, so the file stopped growing. Finalize now instead of
        // leaving the popover looking live. That is what made a 7 minute take
        // come back as a 2 minute file. Keeps whatever was encoded so far.
        void get().stopRecording();
      });
      await onInterrupted(() => {
        const { state } = get();
        if (state.status !== "recording" && state.status !== "paused") return;
        reportError(translateNow("recorder.error.captureInterrupted"));
        void get().stopRecording();
      });
      // Bubble X button — sync toggle without re-invoking hide.
      void listen("camera://closed", () => {
        set({ cameraEnabled: false });
      });
      // Rust is source of truth for overlay visibility (HUD toggle, tray menu, X).
      void listen<boolean>("annotation://visibility", (e) => {
        set({ annotationVisible: e.payload });
      });
      // Annotation bar X — hide runs through hideAnnotationOverlay too, but X can
      // fire before the IPC round-trip; keep the flag in sync immediately.
      void listen("annotation://closed", () => {
        set({ annotationVisible: false });
      });
      // Bar closed / take finished — area pick is session UI, not sticky.
      void listen("recorder://dismissed", () => {
        resetAreaCapture(set, get);
      });
      // Bar reopened — re-warm mic if still selected (Rust cools on dismiss).
      void listen("recorder://shown", () => {
        get().syncMicWarm();
      });
      if (typeof navigator !== "undefined" && navigator.mediaDevices) {
        navigator.mediaDevices.addEventListener("devicechange", () => {
          void get().refreshMediaDevices();
        });
      }
    }
    try {
      set({ state: await commands.recorderState() });
    } catch {
      /* recorder_state never fails, but stay defensive */
    }
    await get().refreshPermissions();
    // OS dialog only — no Capptivo permissions card (macOS TCC / portal).
    if (!get().permissions?.canRecord) {
      await get().requestPermission();
    }
    await get().refreshSources();
    void get().refreshMediaDevices();
  },

  async refreshPermissions() {
    try {
      set({ permissions: await commands.checkPermissions() });
    } catch (e) {
      reportError(describeError(e));
    }
  },

  async requestPermission() {
    try {
      const permissions = await commands.requestScreenPermission();
      set({ permissions });
      if (permissions.canRecord) await get().refreshSources();
    } catch (e) {
      reportError(describeError(e));
    }
  },

  async refreshSources(options = {}) {
    const thumbnails = options.thumbnails === true;
    if (!get().permissions?.canRecord) {
      reportError(translateNow("recorder.error.screenPermission"));
      return;
    }
    set({ loadingSources: true });
    try {
      const sources = await commands.listCaptureSources(thumbnails);
      const { captureMode, selectedSourceId } = get();
      set({
        sources,
        selectedSourceId: pickDefaultSource(sources, captureMode, selectedSourceId),
      });
    } catch (e) {
      reportError(describeError(e));
    } finally {
      set({ loadingSources: false });
    }
  },

  async refreshDevices() {
    set({ loadingDevices: true });
    try {
      const devices = await commands.listCaptureDevices();
      set((s) => ({
        devices,
        deviceError: null,
        // Keep the current pick if it's still plugged in; otherwise fall back to
        // the only device, but never auto-select among several — that would be
        // guessing which phone the user meant.
        selectedDeviceId:
          s.selectedDeviceId && devices.some((d) => d.id === s.selectedDeviceId)
            ? s.selectedDeviceId
            : devices.length === 1
              ? devices[0].id
              : null,
      }));
    } catch (e) {
      // Camera TCC is the usual cause, and it has its own remedy — keep it out
      // of `lastError` so it can't block the Record button for screen capture.
      const message = describeError(e);
      set({
        devices: [],
        selectedDeviceId: null,
        deviceError: /permission/i.test(message)
          ? translateNow("recorder.error.cameraPermission")
          : message,
      });
    } finally {
      set({ loadingDevices: false });
    }
  },

  selectDevice(id) {
    set({ selectedDeviceId: id, captureMode: "device" });
  },

  async refreshMediaDevices() {
    // Cameras: WebView enumerate (face-cam lives in the camera WebView).
    // Mics: native list only — never touch audio getUserMedia here.
    if (navigator.mediaDevices?.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = rawCameras(devices).map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));
        set((s) => ({
          cameras,
          cameraDeviceId:
            s.cameraDeviceId && cameras.some((c) => c.deviceId === s.cameraDeviceId)
              ? s.cameraDeviceId
              : (cameras[0]?.deviceId ?? null),
        }));
      } catch {
        /* enumeration may fail before permission */
      }
    }
    await get().ensureMicrophoneDevices();
  },

  async ensureCameraDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Don't steal the bubble's AVFoundation session — only probe when the
      // face-cam preview is off.
      if (
        !get().cameraEnabled &&
        !hasRequestedCameraLabels &&
        needsLabelUnlock(rawCameras(devices))
      ) {
        hasRequestedCameraLabels = true;
        await probeCameraPermission();
      }
    } catch {
      /* fall through */
    }
    if (navigator.mediaDevices?.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = rawCameras(devices).map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));
        set((s) => ({
          cameras,
          cameraDeviceId:
            s.cameraDeviceId && cameras.some((c) => c.deviceId === s.cameraDeviceId)
              ? s.cameraDeviceId
              : (cameras[0]?.deviceId ?? null),
        }));
      } catch {
        /* ignore */
      }
    }
  },

  async ensureMicrophoneDevices() {
    try {
      const list = await commands.listMicrophones();
      const microphones = list.map((m) => ({
        deviceId: m.deviceId,
        label: m.label,
      }));
      set((s) => ({
        microphones,
        micDeviceId:
          s.micDeviceId && microphones.some((m) => m.deviceId === s.micDeviceId)
            ? s.micDeviceId
            : (microphones[0]?.deviceId ?? null),
      }));
      get().syncMicWarm();
    } catch {
      set({ microphones: [] });
    }
  },

  async requestCameraAccess() {
    hasRequestedCameraLabels = true;
    const { cameraEnabled, cameraDeviceId } = get();
    await probeCameraPermission();
    await get().ensureCameraDevices();
    await reviveCameraPreviewIfOn(cameraEnabled, cameraDeviceId);
  },

  setCaptureMode(mode) {
    const { sources, selectedSourceId } = get();
    if (mode !== "area") {
      void commands.hideAreaFrameGuide().catch(() => undefined);
    }
    set({
      captureMode: mode,
      areaSelection: mode === "area" ? get().areaSelection : null,
      selectedSourceId: pickDefaultSource(sources, mode, selectedSourceId),
    });
    // Phones come and go while the bar is open; the list is only meaningful the
    // moment the user asks for it.
    if (mode === "device") void get().refreshDevices();
  },

  async pickArea() {
    if (!get().permissions?.canRecord) {
      await get().requestPermission();
      if (!get().permissions?.canRecord) {
        reportError(translateNow("recorder.error.screenPermission"));
        return;
      }
    }
    try {
      set({ lastError: null });
      const selection = await commands.pickCaptureArea();
      set({
        captureMode: "area",
        areaSelection: selection,
        selectedSourceId: selection.sourceId,
      });
      try {
        await commands.showAreaFrameGuide(selection);
      } catch (guideErr) {
        // Selection is still valid for record — surface guide failure so friends
        // can see click-through / DPI issues in the HUD + error log.
        reportError(describeError(guideErr));
      }
    } catch (e) {
      const message = describeError(e);
      if (!/cancel/i.test(message)) {
        reportError(message);
      } else {
        void commands.hideAreaFrameGuide().catch(() => undefined);
      }
    }
  },

  clearAreaSelection() {
    void commands.hideAreaFrameGuide().catch(() => undefined);
    resetAreaCapture(set, get);
  },

  selectSource(id) {
    set({ selectedSourceId: id });
  },

  setOption(key, value) {
    set((s) => ({ options: { ...s.options, [key]: value } }));
  },

  setCameraEnabled(enabled) {
    set({ cameraEnabled: enabled });
    if (enabled) {
      // Camera WebView owns getUserMedia — don't open a throwaway stream here
      // (that steals the device and blacks out the preview).
      void (async () => {
        await get().ensureCameraDevices();
        const id = get().cameraDeviceId;
        if (id) await commands.showCameraPreview(id).catch(() => undefined);
      })();
    } else {
      void commands.hideCameraPreview().catch(() => undefined);
    }
  },

  setMicEnabled(enabled) {
    // Selection only for capture — label unlock may one-shot gUM (then revive cam).
    set({ micEnabled: enabled, micSessionMuted: enabled ? false : get().micSessionMuted });
    if (enabled) {
      void get().ensureMicrophoneDevices();
    } else {
      void commands.coolMicrophone().catch(() => undefined);
    }
  },

  toggleMicMute() {
    const next = !get().micSessionMuted;
    const live =
      get().state.status === "recording" || get().state.status === "paused";
    if (live) {
      void commands.setRecordingMicMuted(next).then(
        () => set({ micSessionMuted: next }),
        () => undefined,
      );
      return;
    }
    if (!get().micEnabled) return;
    set({ micSessionMuted: next });
  },

  setAnnotationVisible(visible) {
    set({ annotationVisible: visible });
    logClientInfo(
      "recorder:annotation",
      visible ? "pencil: show requested" : "pencil: hide requested",
    );
    if (visible) {
      // First open builds the WebView — if the user hides before that finishes,
      // the late `show()` would resurrect the bar (felt like needing 2–3 clicks).
      void commands
        .showAnnotationOverlay()
        .then(() => {
          if (!get().annotationVisible) {
            logClientInfo(
              "recorder:annotation",
              "pencil: hide won race after show returned",
            );
            void commands.hideAnnotationOverlay().catch(() => undefined);
          }
        })
        .catch((e) => {
          logClientError("recorder:annotation", e);
        });
    } else {
      void commands.hideAnnotationOverlay().catch(() => undefined);
    }
  },

  setCameraDeviceId(id) {
    set({ cameraDeviceId: id, cameraEnabled: id !== null });
    if (id) {
      // Preview WebView acquires the device; a recorder-side getUserMedia would
      // kill that stream (black bubble when re-opening the camera menu).
      void commands.showCameraPreview(id).catch(() => undefined);
    } else {
      void commands.hideCameraPreview().catch(() => undefined);
    }
  },

  setMicDeviceId(id) {
    set({ micDeviceId: id, micEnabled: id !== null });
    if (id) {
      get().syncMicWarm();
    } else {
      void commands.coolMicrophone().catch(() => undefined);
    }
  },

  syncMicWarm() {
    const { micEnabled, micDeviceId, microphones, state } = get();
    if (
      state.status === "recording" ||
      state.status === "paused" ||
      state.status === "finalizing"
    ) {
      return;
    }
    if (!micEnabled || !micDeviceId) {
      void commands.coolMicrophone().catch(() => undefined);
      return;
    }
    const label =
      microphones.find((m) => m.deviceId === micDeviceId)?.label ?? null;
    void commands
      .warmMicrophone(micDeviceId, label)
      .catch(() => undefined);
  },

  prewarmCapture() {
    const {
      cameraEnabled,
      cameraDeviceId,
      captureMode,
      selectedSourceId,
    } = get();
    prewarmInFlight = (async () => {
      if (captureMode === "window" && selectedSourceId) {
        await commands.prepareWindowCapture(selectedSourceId).catch(() => undefined);
      }
      // Keep the floating bubble where it is — arm MediaRecorder during countdown.
      if (cameraEnabled && cameraDeviceId) {
        await commands.showCameraPreview(cameraDeviceId).catch(() => undefined);
        await commands.armCameraCapture().catch(() => undefined);
      }
    })();
    return prewarmInFlight;
  },

  async startRecording() {
    const {
      selectedSourceId,
      selectedDeviceId,
      options,
      captureMode,
      areaSelection,
      cameraEnabled,
      cameraDeviceId,
      micEnabled,
      micDeviceId,
      microphones,
    } = get();
    // Device capture goes through CoreMediaIO, not ScreenCaptureKit — it needs
    // camera permission, not screen recording, so it must skip the screen gate
    // below or a Mac without screen access could never record a phone.
    if (captureMode !== "device" && !get().permissions?.canRecord) {
      await get().requestPermission();
      if (!get().permissions?.canRecord) {
        reportError(translateNow("recorder.error.screenPermission"));
        return;
      }
    }
    if (captureMode === "device" && !selectedDeviceId) {
      reportError(translateNow("recorder.error.noDevice"));
      return;
    }
    if (captureMode === "area") {
      if (!areaSelection) {
        reportError(translateNow("recorder.error.noArea"));
        return;
      }
    } else if (captureMode !== "device" && !selectedSourceId) {
      reportError(translateNow("recorder.error.noSource"));
      return;
    }
    const captureMicrophone = micEnabled && !!micDeviceId;
    const micLabel =
      microphones.find((m) => m.deviceId === micDeviceId)?.label ?? null;
    // Screen rate is fixed — export is where 30 vs 60 is chosen.
    const rate = { fps: SCREEN_CAPTURE_FPS };
    let config: RecorderConfig;
    if (captureMode === "device") {
      // No crop and no cursor exist for a phone's screen; `captureSystemAudio`
      // means the *device's* own audio, which rides the same muxed stream.
      config = {
        ...options,
        ...rate,
        sourceId: selectedDeviceId!,
        crop: null,
        showCursor: false,
        captureMicrophone,
        microphoneDeviceId: micDeviceId,
        microphoneLabel: micLabel,
      };
    } else if (captureMode === "area" && areaSelection) {
      config = {
        sourceId: areaSelection.sourceId,
        crop: areaSelection.crop,
        ...options,
        ...rate,
        captureMicrophone,
        microphoneDeviceId: micDeviceId,
        microphoneLabel: micLabel,
      };
    } else {
      config = {
        sourceId: selectedSourceId!,
        ...options,
        ...rate,
        captureMicrophone,
        microphoneDeviceId: micDeviceId,
        microphoneLabel: micLabel,
      };
    }
    try {
      set({ lastError: null, elapsed: 0 });
      // Annotations start closed on every recording — the overlay is opt-in
      // via the HUD toggle. Without this, a toggle left on from the previous
      // recording leaks into the next one (Rust hides the window on stop, but
      // this store flag survives, leaving the HUD state stale).
      set({ annotationVisible: false });
      void commands.hideAnnotationOverlay().catch(() => undefined);
      // Mic / face-cam were started when the countdown began; this resolves
      // immediately in that case. Falls back to doing the work when there was no
      // countdown (a direct `startRecording()` call).
      await (prewarmInFlight ?? get().prewarmCapture());
      prewarmInFlight = null;
      await commands.startRecording(config);
      set({ micSessionMuted: false });
      if (captureMode === "area" && areaSelection) {
        await commands.showAreaFrameGuide(areaSelection).catch(() => undefined);
      }
    } catch (e) {
      reportError(describeError(e));
      // Warm mic was taken for the failed start — reopen if still selected.
      get().syncMicWarm();
    }
  },

  async stopRecording() {
    const { cameraEnabled } = get();
    try {
      if (cameraEnabled) {
        // A timeout here is not cosmetic: `stop_recording` drops the camera
        // sink immediately after, so whatever the bubble had not written yet
        // is lost and the face-cam can come back truncated or missing (#22).
        // It cannot be recovered from at this point, but it must not vanish
        // without a trace the way it used to.
        if ((await flushCameraCaptureWithTimeout()) === "timed-out") {
          logClientError(
            "recorder",
            new Error(
              "camera flush timed out before stop; the face-cam track may be truncated",
            ),
          );
        }
      }
      // Rust stops ScreenCaptureKit first, then opens the editor (so the blank
      // editor shell is never in the last frames), then finishes mux/finalize.
      await commands.stopRecording();
      // `hide_recorder` emits `recorder://dismissed` (clears area); belt for guide/cam.
      void commands.hideAreaFrameGuide().catch(() => undefined);
      void commands.hideCameraPreview().catch(() => undefined);
      set({ annotationVisible: false, micSessionMuted: false });
    } catch (e) {
      reportError(describeError(e));
      set({ annotationVisible: false, micSessionMuted: false });
    }
  },

  async togglePause() {
    const { state } = get();
    try {
      if (state.status === "recording") await commands.pauseRecording();
      else if (state.status === "paused") await commands.resumeRecording();
    } catch (e) {
      reportError(describeError(e));
    }
  },
};
});

/** Turn an `AppError` (or anything) into a human string for the UI. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const err = e as { kind?: unknown; message?: unknown };
    if (typeof err.message === "string" && err.message.length > 0) {
      return err.message;
    }
    if (typeof err.kind === "string") return err.kind;
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

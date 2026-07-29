/**
 * Recorder popover store. The recorder *state machine* lives in Rust; this store
 * is a **projection** of the `recorder://…` events plus local UI selection (which
 * source, which toggles). Never keep "am I recording?" anywhere but here, fed
 * from Rust (§6).
 */

import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { commands } from "../../ipc/bindings";
import { onElapsed, onError, onStateChanged } from "../../ipc/events";
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
import {
  ensureMicCaptureListeners,
  flushMicCaptureWithTimeout,
  prepareMic,
  probeMicPermission,
  releaseMic,
} from "./micCapture";
import { probeCameraPermission } from "./cameraAccess";
import { flushCameraCaptureWithTimeout } from "./flushCamera";

export type CaptureMode = CaptureSourceKind | "area" | "device";

/** Local capture options (everything in RecorderConfig except the source id). */
interface CaptureOptions {
  fps: number;
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
  refreshSources: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  selectDevice: (id: string) => void;
  refreshMediaDevices: () => Promise<void>;
  /** Enumerate; if empty, prompt TCC then enumerate again. */
  ensureMicrophoneDevices: () => Promise<void>;
  ensureCameraDevices: () => Promise<void>;
  setCaptureMode: (mode: CaptureMode) => void;
  pickArea: () => Promise<void>;
  selectSource: (id: string) => void;
  setOption: <K extends keyof CaptureOptions>(
    key: K,
    value: CaptureOptions[K],
  ) => void;
  setCameraEnabled: (enabled: boolean) => void;
  setMicEnabled: (enabled: boolean) => void;
  setAnnotationVisible: (visible: boolean) => void;
  setCameraDeviceId: (id: string | null) => void;
  setMicDeviceId: (id: string | null) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  togglePause: () => Promise<void>;
}

const DEFAULT_OPTIONS: CaptureOptions = {
  fps: 30,
  showCursor: true,
  captureSystemAudio: false,
  quality: "balanced",
};

let subscribed = false;

/** Nudge face-cam after recorder-side mic GUM tore down its AVCapture session. */
function reviveCameraPreview(cameraEnabled: boolean): Promise<void> {
  if (!cameraEnabled) return Promise.resolve();
  return emit("camera://revive", null).catch(() => undefined);
}

function normalizeMicrophones(devices: MediaDeviceInfo[]): MediaDeviceOption[] {
  const inputs = devices.filter((d) => d.kind === "audioinput" && d.deviceId);
  const byGroup = new Map<string, MediaDeviceInfo>();
  for (const d of inputs) {
    const key = d.groupId || d.deviceId;
    const prev = byGroup.get(key);
    if (!prev || (!prev.label && d.label)) {
      byGroup.set(key, d);
    }
  }
  return [...byGroup.values()]
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label?.trim() || `Microphone ${i + 1}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
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

export const useRecorderStore = create<RecorderStore>((set, get) => ({
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
  cameraDeviceId: null,
  micDeviceId: null,
  cameras: [],
  microphones: [],
  annotationVisible: false,

  async init() {
    if (!subscribed) {
      subscribed = true;
      ensureMicCaptureListeners();
      await onStateChanged((state) => set({ state }));
      await onElapsed((seconds) => set({ elapsed: seconds }));
      await onError((message) => set({ lastError: message }));
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
      set({ lastError: describeError(e) });
    }
  },

  async requestPermission() {
    try {
      const permissions = await commands.requestScreenPermission();
      set({ permissions });
      if (permissions.canRecord) await get().refreshSources();
    } catch (e) {
      set({ lastError: describeError(e) });
    }
  },

  async refreshSources() {
    if (!get().permissions?.canRecord) return;
    set({ loadingSources: true });
    try {
      const sources = await commands.listCaptureSources();
      const { captureMode, selectedSourceId } = get();
      set({
        sources,
        selectedSourceId: pickDefaultSource(sources, captureMode, selectedSourceId),
      });
    } catch (e) {
      set({ lastError: describeError(e) });
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
          ? "Allow Capptivo in System Settings → Privacy → Camera to record a device."
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
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices
        .filter((d) => d.kind === "videoinput" && !!d.deviceId && isRecorderCamera(d))
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));
      const microphones = normalizeMicrophones(devices);
      set((s) => ({
        cameras,
        microphones,
        cameraDeviceId:
          s.cameraDeviceId && cameras.some((c) => c.deviceId === s.cameraDeviceId)
            ? s.cameraDeviceId
            : (cameras[0]?.deviceId ?? null),
        micDeviceId:
          s.micDeviceId && microphones.some((m) => m.deviceId === s.micDeviceId)
            ? s.micDeviceId
            : (microphones[0]?.deviceId ?? null),
      }));
    } catch {
      /* enumeration may fail before permission */
    }
  },

  async ensureMicrophoneDevices() {
    await get().refreshMediaDevices();
    if (get().microphones.length > 0) return;
    await probeMicPermission();
    await get().refreshMediaDevices();
  },

  async ensureCameraDevices() {
    await get().refreshMediaDevices();
    if (get().cameras.length > 0) return;
    await probeCameraPermission();
    await get().refreshMediaDevices();
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
        set({
          lastError:
            "Allow Capptivo in System Settings → Privacy → Screen Recording, then quit and reopen the app.",
        });
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
      await commands.showAreaFrameGuide(selection);
    } catch (e) {
      const message = describeError(e);
      if (!/cancel/i.test(message)) {
        set({ lastError: message });
      } else {
        void commands.hideAreaFrameGuide().catch(() => undefined);
      }
    }
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
        await get().refreshMediaDevices();
        const id = get().cameraDeviceId;
        if (id) await commands.showCameraPreview(id).catch(() => undefined);
      })();
    } else {
      void commands.hideCameraPreview().catch(() => undefined);
    }
  },

  setMicEnabled(enabled) {
    set({ micEnabled: enabled });
    if (enabled) {
      // prepareMic owns getUserMedia — no throwaway probe (that blacks face-cam).
      void (async () => {
        await get().refreshMediaDevices();
        const { micDeviceId, cameraEnabled } = get();
        if (!micDeviceId) return;
        const opened = await prepareMic(micDeviceId).catch(() => false);
        await get().refreshMediaDevices();
        if (opened) await reviveCameraPreview(cameraEnabled);
      })();
    } else {
      releaseMic();
    }
  },

  setAnnotationVisible(visible) {
    set({ annotationVisible: visible });
    if (visible) {
      // First open builds the WebView — if the user hides before that finishes,
      // the late `show()` would resurrect the bar (felt like needing 2–3 clicks).
      void commands
        .showAnnotationOverlay()
        .then(() => {
          if (!get().annotationVisible) {
            void commands.hideAnnotationOverlay().catch(() => undefined);
          }
        })
        .catch(() => undefined);
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
      void (async () => {
        const { cameraEnabled } = get();
        const opened = await prepareMic(id).catch(() => false);
        await get().refreshMediaDevices();
        if (opened) await reviveCameraPreview(cameraEnabled);
      })();
    } else {
      releaseMic();
    }
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
    } = get();
    // Device capture goes through CoreMediaIO, not ScreenCaptureKit — it needs
    // camera permission, not screen recording, so it must skip the screen gate
    // below or a Mac without screen access could never record a phone.
    if (captureMode !== "device" && !get().permissions?.canRecord) {
      await get().requestPermission();
      if (!get().permissions?.canRecord) {
        set({
          lastError:
            "Allow Capptivo in System Settings → Privacy → Screen Recording, then quit and reopen the app.",
        });
        return;
      }
    }
    if (captureMode === "device" && !selectedDeviceId) {
      set({ lastError: "Connect an iPhone or iPad with a cable, then pick it." });
      return;
    }
    if (captureMode === "area") {
      if (!areaSelection) {
        set({ lastError: "Drag to select a region first." });
        return;
      }
    } else if (captureMode !== "device" && !selectedSourceId) {
      set({ lastError: "Pick a screen or window first." });
      return;
    }
    const captureMicrophone = micEnabled && !!micDeviceId;
    let config: RecorderConfig;
    if (captureMode === "device") {
      // No crop and no cursor exist for a phone's screen; `captureSystemAudio`
      // means the *device's* own audio, which rides the same muxed stream.
      config = {
        ...options,
        sourceId: selectedDeviceId!,
        crop: null,
        showCursor: false,
        captureMicrophone,
      };
    } else if (captureMode === "area" && areaSelection) {
      config = {
        sourceId: areaSelection.sourceId,
        crop: areaSelection.crop,
        ...options,
        captureMicrophone,
      };
    } else {
      config = { sourceId: selectedSourceId!, ...options, captureMicrophone };
    }
    try {
      set({ lastError: null });
      // Annotations start closed on every recording — the overlay is opt-in
      // via the HUD toggle. Without this, a toggle left on from the previous
      // recording leaks into the next one (Rust hides the window on stop, but
      // this store flag survives, leaving the HUD state stale).
      set({ annotationVisible: false });
      void commands.hideAnnotationOverlay().catch(() => undefined);
      if (captureMicrophone && micDeviceId) {
        await prepareMic(micDeviceId).catch(() => undefined);
      }
      // Keep the floating bubble where it is — capture re-acquires inside that window.
      if (cameraEnabled && cameraDeviceId) {
        await commands.showCameraPreview(cameraDeviceId).catch(() => undefined);
      }
      await commands.startRecording(config);
      if (captureMode === "area" && areaSelection) {
        await commands.showAreaFrameGuide(areaSelection).catch(() => undefined);
      }
    } catch (e) {
      set({ lastError: describeError(e) });
    }
  },

  async stopRecording() {
    const { cameraEnabled, micEnabled } = get();
    try {
      if (micEnabled) {
        await flushMicCaptureWithTimeout();
      }
      if (cameraEnabled) {
        await flushCameraCaptureWithTimeout();
      }
      // Rust stops ScreenCaptureKit first, then opens the editor (so the blank
      // editor shell is never in the last frames), then finishes mux/finalize.
      await commands.stopRecording();
      void commands.hideAreaFrameGuide().catch(() => undefined);
      void commands.hideCameraPreview().catch(() => undefined);
      set({ annotationVisible: false });
      if (micEnabled && get().micDeviceId) {
        await prepareMic(get().micDeviceId!).catch(() => undefined);
      }
    } catch (e) {
      set({ lastError: describeError(e) });
    }
  },

  async togglePause() {
    const { state } = get();
    try {
      if (state.status === "recording") await commands.pauseRecording();
      else if (state.status === "paused") await commands.resumeRecording();
    } catch (e) {
      set({ lastError: describeError(e) });
    }
  },
}));

/** Turn an `AppError` (or anything) into a human string for the UI. */
export function describeError(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e) {
    const err = e as { kind: string; message?: string };
    return err.message ?? err.kind;
  }
  return String(e);
}

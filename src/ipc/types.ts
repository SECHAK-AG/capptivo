/** TypeScript mirrors of Rust IPC types — keep in sync with `#[serde(rename_all = "camelCase")]`. */

import type { ExportSnapshot } from "../windows/editor/export/exportSnapshot";

export type CaptureSourceKind = "display" | "window";

export interface CaptureSource {
  id: string;
  kind: CaptureSourceKind;
  title: string;
  width: number;
  height: number;
  isPrimary: boolean;
  thumbnail: string | null;
}

/** USB iPhone/iPad screen source (CoreMediaIO — not a `CaptureSource`). */
export interface CaptureDevice {
  /** `device:{uniqueID}` — goes straight into `RecorderConfig.sourceId`. */
  id: string;
  name: string;
  model: string | null;
  /** `0` until the device has negotiated a format. */
  width: number;
  height: number;
  /** The device carries its own audio, so the phone's sound can be recorded. */
  hasAudio: boolean;
}

export type QualityPreset = "balanced" | "high";

export interface CaptureCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureAreaSelection {
  sourceId: string;
  crop: CaptureCrop;
}

export interface RecorderConfig {
  sourceId: string;
  crop?: CaptureCrop | null;
  fps: number;
  showCursor: boolean;
  captureSystemAudio: boolean;
  captureMicrophone?: boolean;
  /** How much to duck system audio under the mic, 0..1 (both sources only). */
  duckingAmount?: number;
  /** Passed to native SCK/WASAPI mic — prefer with `microphoneLabel`. */
  microphoneDeviceId?: string | null;
  /** Label match when WebView deviceId is an opaque hash. */
  microphoneLabel?: string | null;
  quality: QualityPreset;
}

/** Discriminated by `status`, mirroring the Rust `RecorderState` enum. */
export type RecorderState =
  | { status: "idle" }
  | { status: "countdown"; remaining: number }
  | { status: "recording" }
  | { status: "paused" }
  | { status: "finalizing" }
  | { status: "error"; message: string; fatal: boolean };

export type PermissionState =
  | "granted"
  | "denied"
  | "notDetermined"
  | "unknown";

export interface PermissionStatus {
  screenRecording: PermissionState;
  microphone: PermissionState;
  camera: PermissionState;
  canRecord: boolean;
}

/** What this build/OS can do — mirrors Rust's `capabilities.rs`. */
/** Room around the recorder bar for popovers (logical px, screen work area). */
export interface RecorderMenuSpace {
  above: number;
  below: number;
}

export interface PlatformCapabilities {
  os: "macos" | "windows" | "linux";
  canEnumerateSources: boolean;
  canPickArea: boolean;
  canTrackCursor: boolean;
  canCaptureSystemAudio: boolean;
  canExcludeOverlays: boolean;
  hasGlobalShortcut: boolean;
  needsRestartAfterPermission: boolean;
  /** iPhone / iPad screen capture over USB is available (macOS only). */
  canCaptureDevice: boolean;
}

export interface ProjectSummary {
  id: string;
  title: string | null;
  createdAt: string;
  durationSeconds: number;
  thumbnail: string | null;
}

export interface Project {
  schemaVersion: number;
  id: string;
  title: string | null;
  createdAt: string;
  capture: {
    sourceTitle: string;
    fps: number;
    capturedSystemAudio: boolean;
    /** Legacy: OS cursor baked into screen.mp4. New recordings are always false. */
    showsSystemCursor?: boolean;
    /** How the audio in screen.mp4 is laid out. */
    audioTracks?: "single" | "mixSystemMic";
    /** Ducking amount (0..1) applied to system audio in the mix track. */
    duckingAmount?: number;
  };
  files: {
    screen: string;
    camera: string | null;
    cursor: string | null;
    meta: string;
    thumbnail: string | null;
  };
  editorState: unknown | null;
}

/** The tagged error shape every command rejects with (`AppError` in Rust). */
export interface AppError {
  kind: string;
  message?: string;
}

/** Event payloads emitted on the `recorder://…` channels. */
export type RecorderEvent =
  | { type: "stateChanged"; state: RecorderState }
  | { type: "elapsed"; seconds: number }
  | { type: "level"; micDb: number }
  | { type: "error"; message: string; fatal: boolean };

/**
 * Everything the native engine renders (`RenderDocument` in
 * `src-tauri/engine/src/document.rs`): the editor's export snapshot, values
 * only — presets are resolved before a document is handed over.
 */
export type NativeRenderDocument = Pick<
  ExportSnapshot,
  | "sourceVideoSize"
  | "sourceAspect"
  | "aspectRatioPresetId"
  | "backgroundType"
  | "look"
  | "screenContentCrop"
  | "duration"
  | "segments"
  | "zoomFragments"
  | "blurRegions"
  | "cursorSettings"
  | "recordingMetadata"
  | "faceCam"
  | "cameraOffsetMs"
  | "captions"
  | "captionSettings"
>;

/** `NativeExportArgs` in `commands/native_export.rs`. */
export interface NativeExportArgs {
  job: string;
  destination: string;
  projectId: string;
  screenFile: string;
  cameraFile: string | null;
  background: string | null;
  document: NativeRenderDocument;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  audioPreset: "off" | "podcast";
  hasSystemAudio: boolean;
}

export interface NativeExportResult {
  frames: number;
  seconds: number;
  fps: number;
  gpu: string;
  encoder: string;
}

/** Payload of `export://native-progress`. */
export interface NativeExportProgress {
  job: string;
  done: number;
  total: number;
}

/** TypeScript mirrors of Rust IPC types — keep in sync with `#[serde(rename_all = "camelCase")]`. */

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

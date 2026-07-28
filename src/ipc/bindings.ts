/**
 * The single typed surface for calling Rust. Raw `invoke("string")` is banned
 * everywhere else (§14) — import `commands` from here instead. When `tauri-specta`
 * is wired, this file becomes generated and the shape stays identical.
 *
 * Tauri converts camelCase JS argument keys to the Rust command's snake_case
 * parameters automatically, so the argument objects below use camelCase.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  CaptureAreaSelection,
  CaptureDevice,
  CaptureSource,
  PermissionStatus,
  PlatformCapabilities,
  Project,
  ProjectSummary,
  RecorderConfig,
  RecorderState,
} from "./types";

export const commands = {
  // --- recording ---
  listCaptureSources: () => invoke<CaptureSource[]>("list_capture_sources"),
  /** Attached iPhones / iPads — CoreMediaIO, gated by camera permission. */
  listCaptureDevices: () => invoke<CaptureDevice[]>("list_capture_devices"),
  platformCapabilities: () =>
    invoke<PlatformCapabilities>("platform_capabilities"),
  checkPermissions: () => invoke<PermissionStatus>("check_permissions"),
  requestScreenPermission: () =>
    invoke<PermissionStatus>("request_screen_permission"),
  openScreenRecordingSettings: () =>
    invoke<void>("open_screen_recording_settings"),
  relaunch: () => invoke<void>("relaunch"),
  recorderState: () => invoke<RecorderState>("recorder_state"),
  startRecording: (config: RecorderConfig) =>
    invoke<void>("start_recording", { config }),
  pauseRecording: () => invoke<void>("pause_recording"),
  resumeRecording: () => invoke<void>("resume_recording"),
  stopRecording: () => invoke<string>("stop_recording"),
  pickCaptureArea: () => invoke<CaptureAreaSelection>("pick_capture_area"),
  completeAreaPick: (x: number, y: number, width: number, height: number) =>
    invoke<void>("complete_area_pick", { x, y, width, height }),
  cancelAreaPick: () => invoke<void>("cancel_area_pick"),
  showAreaFrameGuide: (selection: CaptureAreaSelection) =>
    invoke<void>("show_area_frame_guide", { selection }),
  hideAreaFrameGuide: () => invoke<void>("hide_area_frame_guide"),
  hideRecorder: () => invoke<void>("hide_recorder"),
  /** Resize recorder window to hug chrome. */
  setRecorderLayout: (
    layout:
      | "setup"
      | "alert"
      | "dropdown"
      | "menu"
      | "hud"
      | "countdown",
  ) => invoke<void>("set_recorder_layout", { layout }),
  /** Hug the setup pill — pass measured content width (logical px). */
  setRecorderBarWidth: (width: number) =>
    invoke<void>("set_recorder_bar_width", { width }),
  showCameraPreview: (deviceId: string) =>
    invoke<void>("show_camera_preview", { deviceId }),
  hideCameraPreview: () => invoke<void>("hide_camera_preview"),
  /** Close setup bubble without clearing the camera toggle (handoff to recorder). */
  dismissCameraPreview: () => invoke<void>("dismiss_camera_preview"),
  setCameraPreviewVisible: (visible: boolean) =>
    invoke<void>("set_camera_preview_visible", { visible }),
  flushCameraCapture: () => invoke<void>("flush_camera_capture"),
  beginCameraFile: (projectId: string, filename: string) =>
    invoke<void>("begin_camera_file", { projectId, filename }),
  // The chunk is the whole payload: Tauri only transfers raw bytes when the
  // entire invoke argument is a typed array (nested, each byte becomes a JSON
  // decimal number). Append-only, so unlike the export sink there is no
  // position to carry — see plans/016 for the measured cost of getting this
  // wrong.
  writeCameraChunk: (chunk: Uint8Array) =>
    invoke<void>("write_camera_chunk", chunk),
  finishCameraFile: () => invoke<string | null>("finish_camera_file"),
  flushMicCapture: () => invoke<void>("flush_mic_capture"),
  beginMicFile: (projectId: string, filename: string) =>
    invoke<void>("begin_mic_file", { projectId, filename }),
  writeMicChunk: (chunk: Uint8Array) => invoke<void>("write_mic_chunk", chunk),
  finishMicFile: () => invoke<string | null>("finish_mic_file"),
  showAnnotationOverlay: () => invoke<void>("show_annotation_overlay"),
  hideAnnotationOverlay: () => invoke<void>("hide_annotation_overlay"),
  syncAnnotationDisplay: () => invoke<void>("sync_annotation_display"),
  openLibrary: () => invoke<void>("open_library"),
  openEditor: (projectId: string) =>
    invoke<void>("open_editor", { projectId }),
  presentWindow: () => invoke<void>("present_window"),

  getWhisperModelStatus: () =>
    invoke<{ exists: boolean; path: string | null }>("get_whisper_model_status"),
  downloadWhisperModel: () => invoke<string>("download_whisper_model"),
  deleteWhisperModel: () => invoke<void>("delete_whisper_model"),
  generateCaptions: (projectId: string, language?: string) =>
    invoke<{
      srt: string;
      json: string | null;
      silences: { startMs: number; endMs: number }[];
    }>("generate_captions", { projectId, language }),

  // --- projects ---
  listProjects: () => invoke<ProjectSummary[]>("list_projects"),
  loadProject: (id: string) => invoke<Project>("load_project", { id }),
  saveEditorState: (id: string, editorState: unknown) =>
    invoke<void>("save_editor_state", { id, editorState }),
  renameProject: (id: string, title: string | null) =>
    invoke<void>("rename_project", { id, title }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),
  /** Backfill `thumbnail.jpg` once for older projects; returns relative name. */
  ensureThumbnail: (id: string) =>
    invoke<string | null>("ensure_thumbnail", { id }),

  // --- export ---
  // Save path: use `@tauri-apps/plugin-dialog` `save()` from JS (non-blocking).
  // Never invoke a Rust `blocking_save_file` command — deadlocks macOS AppKit.
  beginExport: (path: string) => invoke<number>("begin_export", { path }),
  // Tauri only transfers a payload as raw `application/octet-stream` bytes when
  // the *entire* invoke argument is an ArrayBuffer/typed array — a Uint8Array
  // nested inside an object is JSON-encoded as one decimal number per byte
  // (~3.5x expansion, ~1.1 s of main-thread stringify per 16 MiB chunk). So the
  // chunk *is* the payload and the scalars ride in headers. `position` is the
  // absolute byte offset — streaming muxers write out of order.
  writeExportChunk: (handle: number, position: number, chunk: Uint8Array) =>
    invoke<void>("write_export_chunk", chunk, {
      headers: {
        "x-export-handle": String(handle),
        "x-export-position": String(position),
      },
    }),
  // Ensure a low-res preview proxy exists; returns the original dimensions
  // (authoritative for export) and the proxy filename when it's ready now.
  ensureProxy: (projectId: string) =>
    invoke<{ proxy: string | null; width: number; height: number }>(
      "ensure_proxy",
      { projectId },
    ),
  // Ensure the project's screen.mp4 is a seekable progressive MP4 before export
  // reads it (migrates older fragmented recordings; fast no-op once progressive).
  ensureSeekableRecording: (projectId: string) =>
    invoke<void>("ensure_seekable_recording", { projectId }),
  finishExport: (handle: number) => invoke<string>("finish_export", { handle }),
  abortExport: (handle: number, reason: string) =>
    invoke<void>("abort_export", { handle, reason }),
  // Mux the recorded audio into a video-only export, trimmed to the kept
  // segments and optionally voice-enhanced. No-op when the recording is silent.
  muxExportAudio: (args: {
    projectId: string;
    videoPath: string;
    audioSource: string;
    segments: { start: number; end: number }[];
    preset: "off" | "podcast";
    hasSystemAudio: boolean;
  }) => invoke<void>("mux_export_audio", args),
  // Trim/enhance audio to a sidecar while video encodes (overlaps wall time).
  // `outName` is a bare filename under the project dir (media://-readable).
  // Returns the absolute sidecar path, or null when the recording is silent.
  prepareExportAudio: (args: {
    projectId: string;
    outName: string;
    audioSource: string;
    segments: { start: number; end: number }[];
    preset: "off" | "podcast";
    hasSystemAudio: boolean;
  }) => invoke<string | null>("prepare_export_audio", args),
  // Stream-copy a prepared audio sidecar onto the video-only export.
  attachExportAudio: (args: { videoPath: string; audioPath: string }) =>
    invoke<void>("attach_export_audio", args),
  removeTempFile: (args: { path: string }) => invoke<void>("remove_temp_file", args),
} as const;

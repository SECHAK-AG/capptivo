/** Typed `invoke` surface — raw `invoke("string")` is banned elsewhere. */

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
  RecorderMenuSpace,
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
  /** Resize recorder window to hug chrome. Popovers use `setRecorderMenu`. */
  setRecorderLayout: (
    layout: "setup" | "alert" | "hud" | "hud-mini" | "countdown",
  ) => invoke<void>("set_recorder_layout", { layout }),
  /** Hug the setup pill — pass measured content width (logical px). */
  setRecorderBarWidth: (width: number) =>
    invoke<void>("set_recorder_bar_width", { width }),
  /** Webview-local hitbox of the pill (+ open menu) for overlay click-through. */
  setRecorderBarHitbox: (x: number, y: number, width: number, height: number) =>
    invoke<void>("set_recorder_bar_hitbox", { x, y, width, height }),
  /** Screen room above / below the bar — picks the side a popover opens toward. */
  recorderMenuSpace: () => invoke<RecorderMenuSpace>("recorder_menu_space"),
  /**
   * Legacy — setup is a work-area overlay; Radix flips popovers in-window.
   */
  setRecorderMenu: (side: "top" | "bottom", height: number) =>
    invoke<void>("set_recorder_menu", { side, height }),
  /** Popover open — keep the menu room interactive (no click-through). */
  setRecorderMenuLive: (live: boolean) =>
    invoke<void>("set_recorder_menu_live", { live }),
  /** CSS drag started — keep the overlay interactive (no window resize). */
  beginRecorderDrag: () => invoke<"top" | "bottom">("begin_recorder_drag"),
  /** CSS drag ended — window size untouched. */
  endRecorderDrag: () => invoke<"top" | "bottom">("end_recorder_drag"),
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
  // Chunk must be the whole invoke arg — nested typed arrays JSON-encode per byte.
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
  /** Pause/resume native multi-monitor follow while a drawing tool is armed. */
  setAnnotationDisplayFollow: (follow: boolean) =>
    invoke<void>("set_annotation_display_follow", { follow }),
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

  /** Persist a custom background into the global app-data library. */
  saveCustomBackground: (bytes: Uint8Array, ext: string) =>
    invoke<{ id: string; fileName: string }>("save_custom_background", bytes, {
      headers: { "x-background-ext": ext },
    }),
  listCustomBackgrounds: () =>
    invoke<{ id: string; fileName: string }[]>("list_custom_backgrounds"),
  deleteCustomBackground: (id: string) =>
    invoke<void>("delete_custom_background", { id }),

  // Save path: use `@tauri-apps/plugin-dialog` `save()` — never a blocking Rust picker.
  beginExport: (path: string) => invoke<number>("begin_export", { path }),
  // Chunk is the whole invoke arg; handle/position ride in headers for out-of-order muxers.
  writeExportChunk: (handle: number, position: number, chunk: Uint8Array) =>
    invoke<void>("write_export_chunk", chunk, {
      headers: {
        "x-export-handle": String(handle),
        "x-export-position": String(position),
      },
    }),
  /** Returns original dimensions and proxy filename when ready. */
  ensureProxy: (projectId: string) =>
    invoke<{ proxy: string | null; width: number; height: number }>(
      "ensure_proxy",
      { projectId },
    ),
  /** Migrates fragmented recordings to seekable MP4; no-op once progressive. */
  ensureSeekableRecording: (projectId: string) =>
    invoke<void>("ensure_seekable_recording", { projectId }),
  finishExport: (handle: number) => invoke<string>("finish_export", { handle }),
  abortExport: (handle: number, reason: string) =>
    invoke<void>("abort_export", { handle, reason }),
  /** Mux trimmed audio into a video-only export; no-op when silent. */
  muxExportAudio: (args: {
    projectId: string;
    videoPath: string;
    audioSource: string;
    segments: { start: number; end: number }[];
    preset: "off" | "podcast";
    hasSystemAudio: boolean;
  }) => invoke<void>("mux_export_audio", args),
  /** Prepare a trimmed audio sidecar while video encodes; returns path or null when silent. */
  prepareExportAudio: (args: {
    projectId: string;
    outName: string;
    audioSource: string;
    segments: { start: number; end: number }[];
    preset: "off" | "podcast";
    hasSystemAudio: boolean;
  }) => invoke<string | null>("prepare_export_audio", args),
  attachExportAudio: (args: { videoPath: string; audioPath: string }) =>
    invoke<void>("attach_export_audio", args),
  removeTempFile: (args: { path: string }) => invoke<void>("remove_temp_file", args),
} as const;

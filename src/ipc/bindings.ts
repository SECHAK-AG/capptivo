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
  /** `includeThumbnails: false` skips per-source screenshot capture — use it
   *  for the boot-time list, when no picker menu is open. */
  listCaptureSources: (includeThumbnails: boolean) =>
    invoke<CaptureSource[]>("list_capture_sources", { includeThumbnails }),
  /** Attached iPhones / iPads — CoreMediaIO, gated by camera permission. */
  listCaptureDevices: () => invoke<CaptureDevice[]>("list_capture_devices"),
  /** Native mics — never WebView getUserMedia (that blacks the face-cam). */
  listMicrophones: () =>
    invoke<{ deviceId: string; label: string }[]>("list_microphones"),
  /** Open selected mic early (discard) so Record skips BT open latency. */
  warmMicrophone: (deviceId: string | null, label: string | null) =>
    invoke<void>("warm_microphone", { deviceId, label }),
  /** Tear down warm mic (mic off / bar dismiss). */
  coolMicrophone: () => invoke<void>("cool_microphone"),
  platformCapabilities: () =>
    invoke<PlatformCapabilities>("platform_capabilities"),
  checkPermissions: () => invoke<PermissionStatus>("check_permissions"),
  requestScreenPermission: () =>
    invoke<PermissionStatus>("request_screen_permission"),
  openScreenRecordingSettings: () =>
    invoke<void>("open_screen_recording_settings"),
  relaunch: () => invoke<void>("relaunch"),
  /** Opens the native update dialog flow (same as tray → Check for Updates). */
  checkForUpdates: () => invoke<void>("check_for_updates"),
  recorderState: () => invoke<RecorderState>("recorder_state"),
  /** macOS: unminimize / raise a window source during the countdown. */
  prepareWindowCapture: (sourceId: string) =>
    invoke<void>("prepare_window_capture", { sourceId }),
  startRecording: (config: RecorderConfig) =>
    invoke<void>("start_recording", { config }),
  pauseRecording: () => invoke<void>("pause_recording"),
  resumeRecording: () => invoke<void>("resume_recording"),
  setRecordingMicMuted: (muted: boolean) =>
    invoke<void>("set_recording_mic_muted", { muted }),
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
  /** Build the face-cam MediaRecorder during the countdown, without starting it. */
  armCameraCapture: () => invoke<void>("arm_camera_capture"),
  flushCameraCapture: () => invoke<void>("flush_camera_capture"),
  /**
   * Stamp the face-cam's first frame onto the capture clock; returns the offset
   * in ms from the screen's first frame (signed). Call immediately after
   * `MediaRecorder.start()` — the measurement includes everything after it.
   */
  markCameraStarted: () => invoke<number>("mark_camera_started"),
  beginCameraFile: (projectId: string, filename: string) =>
    invoke<void>("begin_camera_file", { projectId, filename }),
  // Chunk must be the whole invoke arg — nested typed arrays JSON-encode per byte.
  writeCameraChunk: (chunk: Uint8Array) =>
    invoke<void>("write_camera_chunk", chunk),
  finishCameraFile: () => invoke<string | null>("finish_camera_file"),
  showAnnotationOverlay: () => invoke<void>("show_annotation_overlay"),
  hideAnnotationOverlay: () => invoke<void>("hide_annotation_overlay"),
  /** Pause/resume native multi-monitor follow while a drawing tool is armed. */
  setAnnotationDisplayFollow: (follow: boolean) =>
    invoke<void>("set_annotation_display_follow", { follow }),
  openLibrary: () => invoke<void>("open_library"),
  openEditor: (projectId: string) => invoke<void>("open_editor", { projectId }),
  presentWindow: () => invoke<void>("present_window"),

  getWhisperModelStatus: () =>
    invoke<{ exists: boolean; path: string | null }>(
      "get_whisper_model_status",
    ),
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
  /** Annex-B H.264 → ffmpeg `-c copy` MP4 (mux outside the WebView). */
  beginExportH264Stream: (args: { path: string; fps: number }) =>
    invoke<number>("begin_export_h264_stream", args),
  writeExportH264Chunk: (handle: number, chunk: Uint8Array) =>
    invoke<void>("write_export_h264_chunk", chunk, {
      headers: { "x-export-handle": String(handle) },
    }),
  finishExportH264Stream: (handle: number) =>
    invoke<string>("finish_export_h264_stream", { handle }),
  abortExportH264Stream: (handle: number, reason: string) =>
    invoke<void>("abort_export_h264_stream", { handle, reason }),
  /** Pixi RGBA frames → ffmpeg H.264 encode (Path B; encode outside WebView). */
  beginExportRawvideoStream: (args: {
    path: string;
    width: number;
    height: number;
    fps: number;
    bitrate: number;
  }) => invoke<number>("begin_export_rawvideo_stream", args),
  writeExportRawvideoFrame: (handle: number, chunk: Uint8Array) =>
    invoke<void>("write_export_rawvideo_frame", chunk, {
      headers: { "x-export-handle": String(handle) },
    }),
  finishExportRawvideoStream: (handle: number) =>
    invoke<string>("finish_export_rawvideo_stream", { handle }),
  abortExportRawvideoStream: (handle: number, reason: string) =>
    invoke<void>("abort_export_rawvideo_stream", { handle, reason }),
  /** Returns original dimensions and proxy filename when ready. */
  ensureProxy: (projectId: string) =>
    invoke<{ proxy: string | null; width: number; height: number }>(
      "ensure_proxy",
      { projectId },
    ),
  /**
   * Normalizes the recorded face-cam WebM into a seekable H.264 MP4 the
   * `<video>` compositing path can actually upload. `pending` means a transcode
   * is running and `project://camera-ready` will follow.
   */
  ensureCameraTrack: (projectId: string) =>
    invoke<{
      camera: string | null;
      pending: boolean;
      /** Face-cam start offset vs the screen timeline; null when unmeasured. */
      offsetMs: number | null;
    }>("ensure_camera_track", { projectId }),
  /** Migrates fragmented recordings to seekable MP4; no-op once progressive. */
  ensureSeekableRecording: (projectId: string) =>
    invoke<void>("ensure_seekable_recording", { projectId }),
  /** Fail before encode when the destination volume is too full. */
  checkExportDiskSpace: (args: { path: string; needed: number }) =>
    invoke<void>("check_export_disk_space", args),
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
  removeTempFile: (args: { path: string }) =>
    invoke<void>("remove_temp_file", args),
  /** Append one error line to `errors.log`. */
  logClientError: (source: string, message: string) =>
    invoke<void>("log_client_error", { source, message }),
  /** Append one info line to rolling `capptivo.log` (not `errors.log`). */
  logClientInfo: (source: string, message: string) =>
    invoke<void>("log_client_info", { source, message }),
  /** Reveal `logs/errors.log` in Finder / Explorer. */
  revealErrorLog: () => invoke<string>("reveal_error_log"),
  /** Reveal the logs folder (`capptivo.*` + `errors.log`). */
  revealLogsDir: () => invoke<string>("reveal_logs_dir"),
  errorLogPath: () => invoke<string>("error_log_path"),
} as const;

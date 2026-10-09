/**
 * MP4 export through the native engine (`src-tauri/engine`).
 *
 * Rust decodes the recording, composites every frame on the GPU and encodes
 * with the machine's hardware H.264 encoder, muxing the audio in the same
 * pass. The WebView only hands over the export snapshot — no frame crosses
 * IPC — which is what makes this route an order of magnitude faster than
 * compositing in the WebView (see plans/001-export-root-cause-and-architecture.md).
 *
 * Any failure other than a cancel lets the caller fall back to the WebView
 * routes, so an unexpected engine problem costs time, never the export.
 */

import { commands } from "../../../ipc/bindings";
import { onNativeExportProgress } from "../../../ipc/events";
import { exportLog } from "./exportLog";
import { throttledProgress } from "./exportProgress";
import { ExportCancelledError, throwIfAborted } from "./exportCancel";
import type { ExportAudioEnhance, ResolvedExportParams } from "./exportSettings";
import type { ExportSnapshot } from "./exportSnapshot";
import { nativeRenderDocument, projectFileName } from "./nativeDocument";
import { MEDIA_PROTOCOL_BASE } from "@/lib/platform";

/** Support switch: `localStorage["capptivo.legacyExport"] = "1"` or the env flag. */
export function nativeExportEnabled(): boolean {
  if (import.meta.env.VITE_CAPPTIVO_LEGACY_EXPORT === "1") return false;
  try {
    return globalThis.localStorage?.getItem("capptivo.legacyExport") !== "1";
  } catch {
    return true;
  }
}

/** 128 random bits as hex; `getRandomValues` works outside secure contexts. */
function newJobId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stage the background the preview is showing — the same bytes, whether a
 * bundled preset, a custom image or a rasterized gradient/colour data URL.
 */
async function stageBackground(image: HTMLImageElement | null): Promise<string | null> {
  if (!image?.src) return null;
  const response = await fetch(image.src);
  if (!response.ok) {
    throw new Error(`background image unavailable (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return commands.stageExportAsset(bytes);
}

/**
 * Render the whole MP4 natively into `destination`. Resolves when the file is
 * complete (audio included); throws `ExportCancelledError` when cancelled.
 */
export async function exportMp4Native(
  destination: string,
  resolved: ResolvedExportParams,
  audioEnhance: ExportAudioEnhance,
  signal: AbortSignal,
  snapshot: ExportSnapshot,
): Promise<void> {
  throwIfAborted(signal);
  const job = newJobId();
  const background = await stageBackground(snapshot.backgroundImage);
  throwIfAborted(signal);

  let progress: ((done: number) => void) | null = null;
  const unlisten = await onNativeExportProgress((p) => {
    if (p.job !== job) return;
    progress ??= throttledProgress(p.total);
    progress(p.done);
  });
  const cancel = () => {
    void commands.cancelNativeExport(job).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await commands.exportNative({
      job,
      destination,
      projectId: snapshot.projectId,
      screenFile: snapshot.project.files.screen,
      cameraFile: projectFileName(
        snapshot.cameraUrl,
        snapshot.projectId,
        MEDIA_PROTOCOL_BASE,
      ),
      background,
      document: nativeRenderDocument(snapshot),
      width: resolved.width,
      height: resolved.height,
      fps: resolved.fps,
      bitrate: resolved.bitrate,
      audioPreset: audioEnhance,
      hasSystemAudio: snapshot.project.capture.capturedSystemAudio,
    });
    exportLog(
      `[export] native: ${result.frames} frames in ${result.seconds.toFixed(1)}s ` +
        `(${result.fps.toFixed(1)} fps) gpu=${result.gpu} encoder=${result.encoder}`,
    );
  } catch (error) {
    if (signal.aborted) throw new ExportCancelledError();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    unlisten();
  }
}

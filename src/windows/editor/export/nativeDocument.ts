/**
 * The export snapshot → the native engine's render document
 * (`RenderDocument` in `src-tauri/engine/src/document.rs`).
 *
 * Pure and alias-free on purpose: the engine's contract test
 * (`src-tauri/engine/tests/golden/generate.mjs`) runs this exact function and
 * the Rust side must deserialize what it produces.
 */

import type { NativeRenderDocument } from "../../../ipc/types";
import type { ExportSnapshot } from "./exportSnapshot";

/** The render inputs, exactly as the preview composites them. */
export function nativeRenderDocument(snapshot: ExportSnapshot): NativeRenderDocument {
  return {
    sourceVideoSize: snapshot.sourceVideoSize,
    sourceAspect: snapshot.sourceAspect,
    aspectRatioPresetId: snapshot.aspectRatioPresetId,
    backgroundType: snapshot.backgroundType,
    look: snapshot.look,
    screenContentCrop: snapshot.screenContentCrop,
    duration: snapshot.duration,
    segments: snapshot.segments,
    zoomFragments: snapshot.zoomFragments,
    blurRegions: snapshot.blurRegions,
    cursorSettings: snapshot.cursorSettings,
    recordingMetadata: snapshot.recordingMetadata,
    faceCam: snapshot.faceCam,
    cameraOffsetMs: snapshot.cameraOffsetMs,
    captions: snapshot.captions,
    captionSettings: snapshot.captionSettings,
  };
}

/**
 * `<base>/<projectId>/<file>` → `<file>`; null for anything that is not a
 * plain file directly inside the project.
 */
export function projectFileName(
  url: string | null,
  projectId: string,
  mediaBase: string,
): string | null {
  if (!url) return null;
  const prefix = `${mediaBase}/${projectId}/`;
  if (!url.startsWith(prefix)) return null;
  const name = decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0]);
  return name && !name.includes("/") && !name.includes("\\") ? name : null;
}

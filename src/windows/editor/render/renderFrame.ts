/**
 * Shared look / frame input types and zoom-reactive helpers used by the Pixi
 * compositor (preview + export). Composition itself lives in `pixiCompositor`.
 */

import {
  computeFaceCamZoomPresenceScale,
  computeZoomEnvelope,
  getFaceCamZoomPresenceMinScale,
  getShrinkFaceCamDuringZoom,
  type CursorLoopReturn,
  type CursorSettings,
  type RecordingMetadata,
  type ScreenContentCropNorm,
  type ZoomFragment,
} from "@/engine";
import type { AspectRatioPresetId } from "../lib/composition";
import type { FaceCamParams } from "../store";

export interface LookState {
  devicePadding: number;
  cornerRadius: number;
  recordingShadowIntensity: number;
  backgroundBlur: number;
  backgroundDarkness: number;
}

export interface RenderFrameInputs {
  width: number;
  height: number;
  video: HTMLVideoElement | null;
  /** Optional face-cam track composited on top of the screen recording. */
  cameraVideo?: HTMLVideoElement | null;
  faceCam?: FaceCamParams;
  sourceAspect: number;
  background: CanvasImageSource | null;
  look: LookState;
  /** Camera magnification for this frame (1 = none). */
  zoomScale?: number;
  /**
   * What the camera centres on, normalized 0–1 **inside the recording rect** —
   * the space `zoomMotion` bakes and the cursor overlay is placed in. The only
   * coordinate space in the zoom path; see `cameraTransform.ts`.
   */
  zoomFocus?: { x: number; y: number };
  /**
   * Full follow-cursor target scale while easing. Drives Recordly-style
   * progress·finalOffset translation in `computeCameraTransform`.
   */
  zoomTargetScale?: number;
  /** Eased face-cam shrink for the active zoom (1 = full size). */
  faceCamPresenceScale?: number;
  screenContentCrop?: ScreenContentCropNorm | null;
  /** Source time (seconds) for cursor overlay; omit to skip. */
  cursorTime?: number;
  /** Snap cursor spring (seek / scrub / pause). Export leaves this false. */
  cursorFreeze?: boolean;
  cursorSettings?: CursorSettings;
  /** Loop-return glide window for the cursor (null/omit = off). */
  cursorLoopReturn?: CursorLoopReturn | null;
  recordingMetadata?: RecordingMetadata | null;
  /** Composition context for layout rules. */
  aspectRatioPresetId?: AspectRatioPresetId;
  backgroundType?: "image" | "gradient" | "color";
  sourceVideoSize?: { width: number; height: number } | null;
}

/**
 * Per-frame zoom-reactive state derived from the active fragment: how far the
 * face cam has eased down. Rides the fragment's eased envelope so it animates
 * in lockstep with the zoom motion instead of snapping at the fragment edges.
 * Shared by the preview and export call sites so both composite identical frames.
 */
export function resolveZoomReactiveState(
  activeZoom: ZoomFragment | null,
  sourceTime: number,
): {
  faceCamPresenceScale: number;
  zoomTargetScale?: number;
} {
  if (!activeZoom) {
    return {
      faceCamPresenceScale: 1,
    };
  }

  const faceCamPresenceScale = getShrinkFaceCamDuringZoom(activeZoom)
    ? computeFaceCamZoomPresenceScale(
        computeZoomEnvelope(activeZoom, sourceTime),
        getFaceCamZoomPresenceMinScale(activeZoom),
      )
    : 1;

  // Follow-cursor ease-in/out: tell the camera the full S so translation can
  // use Recordly's progress * finalOffset (fixed-rect keeps classic path).
  const zoomTargetScale =
    activeZoom.mode === "follow-cursor"
      ? Math.max(1, activeZoom.targetScale)
      : undefined;

  return {
    faceCamPresenceScale,
    ...(zoomTargetScale != null ? { zoomTargetScale } : {}),
  };
}

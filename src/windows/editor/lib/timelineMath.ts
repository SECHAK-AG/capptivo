/** Timeline constants + fragment factories shared by the store and Timeline UI. */

import {
  createZoomFragmentId,
  getFaceCamZoomPresenceMinScale,
  type RecordingMetadata,
  type ZoomFragment,
} from "@/engine";

export { formatTimelineTime, buildTimelineRuler } from "./timelineRuler";
export type { TimelineRulerTick } from "./timelineRuler";

export const MIN_SEGMENT_LENGTH = 0.2;
export const HISTORY_LIMIT = 120;
export const ZOOM_DEFAULT_DURATION = 3;

export function computeDefaultZoomRange(
  playhead: number,
  boundsStart: number,
  boundsEnd: number,
  minLength: number,
): { start: number; end: number } {
  const maxLength = Math.max(minLength, boundsEnd - boundsStart);
  const length = Math.min(ZOOM_DEFAULT_DURATION, maxLength);

  let start = playhead - length / 2;
  let end = playhead + length / 2;

  if (start < boundsStart) {
    start = boundsStart;
    end = start + length;
  }
  if (end > boundsEnd) {
    end = boundsEnd;
    start = end - length;
  }

  start = Math.max(boundsStart, start);
  end = Math.min(boundsEnd, end);

  if (end - start < minLength) {
    end = Math.min(boundsEnd, start + minLength);
    start = Math.max(boundsStart, end - minLength);
  }

  return { start, end };
}

export function createDefaultZoomFragment(
  start: number,
  end: number,
  metadata: RecordingMetadata | null,
): ZoomFragment {
  const mode =
    metadata && metadata.cursorSamples.length > 0
      ? "follow-cursor"
      : "fixed-rect";

  return {
    id: createZoomFragmentId(),
    start,
    end: Math.max(start + MIN_SEGMENT_LENGTH, end),
    mode,
    fixedMode: "frame",
    shrinkFaceCamDuringZoom: true,
    faceCamZoomPresenceScale: getFaceCamZoomPresenceMinScale(null),
    targetScale: 1.35,
    easeIn: 1,
    easeOut: 1,
    damping: 4,
    fixedRect:
      mode === "fixed-rect"
        ? { x: 0.3, y: 0.25, width: 0.4, height: 0.5 }
        : undefined,
  };
}

/** Follow-cursor fragment from a click-cluster suggestion (1.5×). */
export function createSuggestedZoomFragment(
  start: number,
  end: number,
  metadata: RecordingMetadata | null,
  targetScale = 1.5,
): ZoomFragment {
  const base = createDefaultZoomFragment(start, end, metadata);
  return {
    ...base,
    mode: "follow-cursor",
    targetScale,
    fixedRect: undefined,
  };
}

/** Compact label for zoom blocks (e.g. `1.5x`). */
export function formatZoomScaleLabel(scale: number): string {
  const n = Math.round(scale * 10) / 10;
  return `${n}x`;
}

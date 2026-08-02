/**
 * Timeline → face-cam media time.
 *
 * `offsetMs = cameraStart − screenStart`. Playback seeks the cam to
 * `timeline − offset`, clamped into the file.
 */

/**
 * WKWebView paints a blank frame at exact `0` even when pixels are decoded.
 * Park a hair inside the file instead. Same for EOF (`ended`).
 */
const EDGE_EPSILON = 0.001;

export type FaceCamTrack = {
  url: string | null;
  /** `null` on takes recorded before the offset was measured (= aligned). */
  offsetMs: number | null;
};

export type FaceCamFrame =
  /** No usable duration yet — draw no face-cam. */
  | { state: "before" }
  /** Inside the recorded span; the element may play. */
  | { state: "active"; mediaTime: number }
  /** Past the cam's last frame — freeze (cam stops a beat before screen). */
  | { state: "hold"; mediaTime: number };

/** `clamp(currentTime − offsetMs/1000, 0…duration)`. */
export function faceCamFrameAt(
  timelineTime: number,
  offsetMs: number | null | undefined,
  camDuration: number,
): FaceCamFrame {
  if (!(camDuration > 0) || !Number.isFinite(timelineTime)) {
    return { state: "before" };
  }

  const offsetSec = Number.isFinite(offsetMs) ? (offsetMs as number) / 1000 : 0;
  const shifted = timelineTime - offsetSec;
  const lastFrame = Math.max(0, camDuration - EDGE_EPSILON);

  if (shifted >= lastFrame) {
    return { state: "hold", mediaTime: lastFrame };
  }

  // Clamp negatives to the first paintable frame.
  return {
    state: "active",
    mediaTime: Math.max(EDGE_EPSILON, Math.min(shifted, lastFrame)),
  };
}

export function faceCamMediaTime(
  timelineTime: number,
  offsetMs: number | null | undefined,
  camDuration: number,
): number | null {
  const frame = faceCamFrameAt(timelineTime, offsetMs, camDuration);
  return frame.state === "before" ? null : frame.mediaTime;
}

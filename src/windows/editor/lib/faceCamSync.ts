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
  /**
   * Outside the recorded span on either side — draw `mediaTime`, but freeze:
   * the cam starts a beat after the screen and stops a beat before it, and in
   * both gaps the timeline maps to one pinned frame. An element left playing
   * against a pinned target runs away from it and gets seeked back, over and
   * over, for the whole length of the gap.
   */
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

  // Lead-in: the screen was already rolling before the cam opened, so every
  // timeline time here maps to the same first frame. Hold it. `shifted === 0`
  // is the cam's own first frame, not lead-in, so it stays active.
  if (shifted < 0) {
    return { state: "hold", mediaTime: EDGE_EPSILON };
  }

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

/**
 * Only a genuine jump — a scrub taken while playing — seeks during playback.
 * Ordinary drift is absorbed by `faceCamPlaybackRate` instead, because a seek
 * rewinds the picture and is far more visible than the drift it corrects.
 */
export const FACE_CAM_PLAY_DRIFT_SEC = 0.3;
/** Paused, the two clocks are static, so hold them tight for scrub accuracy. */
export const FACE_CAM_PAUSED_DRIFT_SEC = 0.04;
/** A paused timeline move bigger than this is a scrub, not drift. */
export const FACE_CAM_TIMELINE_JUMP_SEC = 0.25;

/** Does the cam element need a corrective seek for this frame? */
export function shouldSeekFaceCam({
  desiredTime,
  isPlaying,
  isSeeking,
  previousTimelineTime,
  timelineTime,
  cameraCurrentTime,
}: {
  desiredTime: number;
  isPlaying: boolean;
  isSeeking: boolean;
  previousTimelineTime: number | null;
  timelineTime: number;
  cameraCurrentTime: number;
}): boolean {
  // Re-assigning `currentTime` while a seek is in flight aborts and restarts
  // it. Do that once per rendered frame and the element never settles — it
  // replays the same fraction of a second for as long as the clocks disagree,
  // which is the face-cam "looping" at the start of playback.
  if (isSeeking) return false;

  const drift = Math.abs(cameraCurrentTime - desiredTime);
  // Playing, the timeline advances by design — only drift is meaningful.
  if (isPlaying) return drift > FACE_CAM_PLAY_DRIFT_SEC;

  const jumped =
    previousTimelineTime === null ||
    Math.abs(timelineTime - previousTimelineTime) > FACE_CAM_TIMELINE_JUMP_SEC;
  return jumped || drift > FACE_CAM_PAUSED_DRIFT_SEC;
}

/** `HTMLMediaElement.HAVE_FUTURE_DATA` — enough buffered to advance a frame. */
const HAVE_FUTURE_DATA = 3;

/**
 * Is the screen track's clock actually advancing?
 *
 * The cam has no timeline of its own; it rides `screen.currentTime`. So it must
 * not roll while that clock is stopped — seeking to a new position, or still
 * buffering after one. A cam playing against a stalled reference runs away from
 * it until the gap earns a corrective seek, and that seek replays everything it
 * covered. Holding the cam still instead costs nothing: the screen is not
 * moving either, so there is no motion to be late for.
 */
export function screenClockIsRolling(
  screen: { paused: boolean; seeking: boolean; readyState: number } | null,
): boolean {
  if (!screen) return false;
  return (
    !screen.paused && !screen.seeking && screen.readyState >= HAVE_FUTURE_DATA
  );
}

/** Inside this the cam counts as on-clock and runs untouched at 1×. */
export const FACE_CAM_SYNC_TOLERANCE_SEC = 0.02;
/** Ceiling on the correction. A face at ±8% speed does not read as wrong. */
export const FACE_CAM_MAX_RATE_ADJUST = 0.08;
/** Roughly the wall time a correction is spread over. */
export const FACE_CAM_CORRECTION_WINDOW_SEC = 1;

/**
 * Playback rate that walks the cam back onto the screen's clock.
 *
 * Two elements on two decoder clocks drift apart continuously, and the only
 * other way to close that is a seek — which rewinds the picture, and whose cost
 * lands all at once wherever it happens. Worse, tolerating drift while playing
 * and then correcting it on pause means every pause rewinds by the accumulated
 * error and the resumed cam replays that stretch. Absorbing it a few percent at
 * a time keeps the error near zero, so no transition has anything to correct.
 */
export function faceCamPlaybackRate(
  cameraCurrentTime: number,
  desiredTime: number,
): number {
  const error = desiredTime - cameraCurrentTime;
  if (!Number.isFinite(error)) return 1;
  // Deadband, or the rate would chase sub-frame noise forever.
  if (Math.abs(error) <= FACE_CAM_SYNC_TOLERANCE_SEC) return 1;
  const adjust = Math.max(
    -FACE_CAM_MAX_RATE_ADJUST,
    Math.min(FACE_CAM_MAX_RATE_ADJUST, error / FACE_CAM_CORRECTION_WINDOW_SEC),
  );
  return 1 + adjust;
}

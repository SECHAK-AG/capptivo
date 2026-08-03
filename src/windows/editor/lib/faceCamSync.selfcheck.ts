/** Selfcheck: faceCamSync clamp + seek-gate semantics. */

import {
  faceCamFrameAt,
  faceCamMediaTime,
  FACE_CAM_PLAY_DRIFT_SEC,
  shouldSeekFaceCam,
} from "./faceCamSync.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const dur = 10;

assert(faceCamFrameAt(0, 0, dur).state === "active", "aligned start is active");
assert(
  faceCamFrameAt(0.5, 1000, dur).state === "active",
  "before offset clamps to first frame",
);
{
  const f = faceCamFrameAt(0.5, 1000, dur);
  assert(f.state === "active" && f.mediaTime > 0, "clamped mediaTime > 0");
}
assert(
  faceCamFrameAt(1.5, 1000, dur).state === "active",
  "past offset → active",
);
{
  const f = faceCamFrameAt(1.5, 1000, dur);
  assert(
    f.state === "active" && Math.abs(f.mediaTime - 0.5) < 1e-9,
    "mediaTime = t − offset",
  );
}
assert(faceCamFrameAt(20, 0, dur).state === "hold", "past EOF holds");
assert(
  faceCamMediaTime(0.5, 1000, dur) !== null,
  "clamped frame is exportable",
);
assert(
  faceCamMediaTime(0, null, dur) !== null,
  "null offset treated as aligned",
);

assert(
  shouldSeekFaceCam({
    desiredTime: 10.5,
    isPlaying: true,
    isSeeking: true,
    previousTimelineTime: 10,
    timelineTime: 10.5,
    cameraCurrentTime: 9.8,
  }) === false,
  "no seek while element is seeking",
);

assert(
  shouldSeekFaceCam({
    desiredTime: 10.5,
    isPlaying: true,
    isSeeking: false,
    previousTimelineTime: 10,
    timelineTime: 10.5,
    cameraCurrentTime: 10.5 - FACE_CAM_PLAY_DRIFT_SEC - 0.01,
  }) === true,
  "seek when play drift exceeds threshold",
);

assert(
  shouldSeekFaceCam({
    desiredTime: 10.5,
    isPlaying: true,
    isSeeking: false,
    previousTimelineTime: 10,
    timelineTime: 10.5,
    cameraCurrentTime: 10.4,
  }) === false,
  "free-run under play drift threshold",
);

assert(
  shouldSeekFaceCam({
    desiredTime: 5,
    isPlaying: false,
    isSeeking: false,
    previousTimelineTime: 1,
    timelineTime: 5,
    cameraCurrentTime: 5,
  }) === true,
  "timeline jump forces seek even if cam time matches",
);

assert(
  shouldSeekFaceCam({
    desiredTime: 0.001,
    isPlaying: false,
    isSeeking: false,
    previousTimelineTime: 0,
    timelineTime: 0,
    cameraCurrentTime: 0.001,
  }) === false,
  "paused snap skips when already on target",
);

console.log("faceCamSync.selfcheck: ok");

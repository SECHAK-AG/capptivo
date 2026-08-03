/** Selfcheck: faceCamSync clamp + seek-gate semantics. */

import {
  faceCamFrameAt,
  faceCamMediaTime,
  faceCamPlaybackRate,
  screenClockIsRolling,
  FACE_CAM_MAX_RATE_ADJUST,
  FACE_CAM_PAUSED_DRIFT_SEC,
  FACE_CAM_PLAY_DRIFT_SEC,
  FACE_CAM_SYNC_TOLERANCE_SEC,
  shouldSeekFaceCam,
} from "./faceCamSync.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const dur = 10;

assert(faceCamFrameAt(0, 0, dur).state === "active", "aligned start is active");
assert(
  faceCamFrameAt(0.5, 1000, dur).state === "hold",
  "lead-in holds rather than playing against a pinned target",
);
{
  const f = faceCamFrameAt(0.5, 1000, dur);
  assert(f.state === "hold" && f.mediaTime > 0, "clamped mediaTime > 0");
}
{
  // Every timeline time inside the lead-in maps to the same held frame, so a
  // playing element would run away from it and be seeked back on a loop.
  const a = faceCamFrameAt(0.1, 1000, dur);
  const b = faceCamFrameAt(0.9, 1000, dur);
  assert(
    a.state === "hold" && b.state === "hold" && a.mediaTime === b.mediaTime,
    "lead-in pins one frame across the whole gap",
  );
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

assert(faceCamPlaybackRate(10, 10) === 1, "on-clock cam runs at 1x");
assert(
  faceCamPlaybackRate(10, 10 + FACE_CAM_SYNC_TOLERANCE_SEC / 2) === 1,
  "sub-tolerance error stays in the deadband",
);
assert(faceCamPlaybackRate(10, 10.2) > 1, "cam behind speeds up");
assert(faceCamPlaybackRate(10.2, 10) < 1, "cam ahead slows down");
assert(
  faceCamPlaybackRate(0, 100) <= 1 + FACE_CAM_MAX_RATE_ADJUST &&
    faceCamPlaybackRate(100, 0) >= 1 - FACE_CAM_MAX_RATE_ADJUST,
  "correction is capped in both directions",
);

{
  const settled = 1 / (1 + FACE_CAM_MAX_RATE_ADJUST);
  assert(
    FACE_CAM_SYNC_TOLERANCE_SEC < FACE_CAM_PAUSED_DRIFT_SEC,
    "rate deadband settles inside the paused seek threshold",
  );
  assert(settled > 0, "correction cap is a usable rate");
  assert(
    shouldSeekFaceCam({
      desiredTime: 10,
      isPlaying: false,
      isSeeking: false,
      previousTimelineTime: 10,
      timelineTime: 10,
      cameraCurrentTime: 10 + FACE_CAM_SYNC_TOLERANCE_SEC,
    }) === false,
    "a cam left inside the deadband survives pause without a snap",
  );
}

{
  const rolling = { paused: false, seeking: false, readyState: 4 };
  assert(screenClockIsRolling(rolling), "playing screen clock is rolling");
  assert(
    screenClockIsRolling(null) === false,
    "no screen track is not rolling",
  );
  assert(
    screenClockIsRolling({ ...rolling, paused: true }) === false,
    "paused screen clock is not rolling",
  );
  // The timeline-click regression: the click pauses, the seek re-decodes, and
  // for that window the screen clock is stopped. A cam allowed to roll there
  // outruns it and gets seeked back, replaying whatever it covered.
  assert(
    screenClockIsRolling({ ...rolling, seeking: true }) === false,
    "seeking screen clock is not rolling",
  );
  assert(
    screenClockIsRolling({ ...rolling, readyState: 1 }) === false,
    "screen clock still buffering is not rolling",
  );
}

console.log("faceCamSync.selfcheck: ok");

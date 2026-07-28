/**
 * Tracks which sample an `HTMLVideoElement` has actually presented.
 *
 * Display refresh and decoded cadence diverge (60 Hz UI vs 30 fps / VFR
 * capture). `requestVideoFrameCallback` fires once per presented sample; we
 * store that id so the compositor can skip GPU uploads when rAF / look-tweaks
 * repaint the same pixels. Seek bumps a generation so a scrub cannot reuse a
 * stale presented-frame id.
 *
 * No-op tracking when RVFC is missing — callers then always upload (safe).
 */

export type VideoFrameStamp = {
  /** Last `presentedFrames` from RVFC; `null` until the first callback. */
  presentedFrames: number | null;
  /** Bumped on `seeked` / `emptied` so scrubbed frames always re-upload. */
  generation: number;
};

export type UploadedVideoStamp = {
  /** Last uploaded presentedFrames; `null` if we uploaded while still waiting. */
  presentedFrames: number | null;
  generation: number;
};

type Track = VideoFrameStamp & {
  rvfcHandle: number | null;
  subscribers: number;
  onInvalidate: () => void;
  /** Latest subscriber's presented-sample hook; see `trackVideoFrames`. */
  onPresented: (() => void) | undefined;
};

const tracks = new WeakMap<HTMLVideoElement, Track>();

function supportsRvfc(video: HTMLVideoElement): video is HTMLVideoElement & {
  requestVideoFrameCallback: (
    callback: (now: number, metadata: VideoFrameCallbackMetadata) => void,
  ) => number;
  cancelVideoFrameCallback: (handle: number) => void;
} {
  return typeof video.requestVideoFrameCallback === "function";
}

/**
 * Pure upload gate for a video element stamp. Exported for the self-check.
 *
 * - Untracked (`stamp == null`) → always upload.
 * - No prior upload → upload.
 * - Seek/emptied bumped generation → upload.
 * - Same generation, still waiting on RVFC → skip (paused look-tweaks).
 * - RVFC id arrived after a wait-upload → upload once, then skip while stable.
 *
 * Skipping while `presentedFrames == null` is only safe because the caller
 * never records a stamp for an upload that had no decoded pixels — see
 * `SourceTexture.rememberBound`. Without that guard this gate would freeze the
 * empty first upload onto the stage forever.
 */
export function videoStampNeedsUpload(
  uploaded: UploadedVideoStamp | null,
  stamp: VideoFrameStamp | null,
): boolean {
  if (!stamp) return true;
  if (!uploaded) return true;
  if (uploaded.generation !== stamp.generation) return true;
  if (stamp.presentedFrames === null) return false;
  return uploaded.presentedFrames !== stamp.presentedFrames;
}

/** Current stamp, or `null` when the element is not being tracked. */
export function videoFrameStamp(
  video: HTMLVideoElement,
): VideoFrameStamp | null {
  const track = tracks.get(video);
  if (!track) return null;
  return {
    presentedFrames: track.presentedFrames,
    generation: track.generation,
  };
}

/**
 * Start (or refcount) RVFC + seek tracking on `video`. Returns an unsubscribe
 * that stops the callbacks when the last subscriber leaves.
 *
 * `onPresented` fires when RVFC reports a sample after a stretch of
 * `presentedFrames == null` (first decode, or post-seek), letting a paused
 * preview schedule the compose that uploads those pixels. The most recent
 * subscriber's hook wins — keeping the first one would leave a stale closure
 * pointing at an unmounted render's `requestPaint`.
 *
 * Without RVFC this is a no-op returning a no-op unsubscribe: with no track,
 * `videoFrameStamp` reports `null` and callers upload on every bind, which is
 * slower but always correct.
 */
export function trackVideoFrames(
  video: HTMLVideoElement,
  onPresented?: () => void,
): () => void {
  if (!supportsRvfc(video)) return () => {};

  let track = tracks.get(video);
  if (!track) {
    const created: Track = {
      presentedFrames: null,
      generation: 0,
      rvfcHandle: null,
      subscribers: 0,
      onPresented,
      onInvalidate: () => {
        const t = tracks.get(video);
        if (!t) return;
        t.generation += 1;
        // Force the next bind to upload even if presentedFrames collides.
        t.presentedFrames = null;
      },
    };
    track = created;
    tracks.set(video, created);

    video.addEventListener("seeked", created.onInvalidate);
    video.addEventListener("emptied", created.onInvalidate);

    const tick = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      const t = tracks.get(video);
      if (!t) return;
      const wasWaiting = t.presentedFrames === null;
      t.presentedFrames = metadata.presentedFrames;
      if (wasWaiting) t.onPresented?.();
      t.rvfcHandle = video.requestVideoFrameCallback(tick);
    };
    created.rvfcHandle = video.requestVideoFrameCallback(tick);
  } else if (onPresented) {
    track.onPresented = onPresented;
  }
  track.subscribers += 1;

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const t = tracks.get(video);
    if (!t) return;
    t.subscribers -= 1;
    if (t.subscribers > 0) return;
    video.removeEventListener("seeked", t.onInvalidate);
    video.removeEventListener("emptied", t.onInvalidate);
    if (t.rvfcHandle != null && supportsRvfc(video)) {
      video.cancelVideoFrameCallback(t.rvfcHandle);
    }
    tracks.delete(video);
  };
}

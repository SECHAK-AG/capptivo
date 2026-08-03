import { snapTimeToKeptRange } from "@/engine";

import { useEditorStore } from "../store";
import { mediaDuration } from "./mediaDuration";
import {
  FIRST_PRESENTABLE_TIME,
  presentableVideoTime,
} from "./presentableVideoTime";
import { playbackUiDue, PLAYBACK_UI_INTERVAL_MS } from "./playbackTime";

export { FIRST_PRESENTABLE_TIME, presentableVideoTime };
export { PLAYBACK_UI_HZ, PLAYBACK_UI_INTERVAL_MS } from "./playbackTime";

export function isEditorTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null;
  const tag = el?.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable === true
  );
}

function seekVideo(video: HTMLVideoElement, time: number) {
  const { segments, setCurrentTime } = useEditorStore.getState();
  const snapped =
    segments.length > 0 ? snapTimeToKeptRange(segments, time) : time;
  video.currentTime = presentableVideoTime(snapped, video.duration);
  setCurrentTime(snapped);
}

/** Play / pause — shared by transport bar and Space. */
export function toggleEditorPlayback(video: HTMLVideoElement | null): void {
  const { isPlaying, currentTime, segments, setPlaying } =
    useEditorStore.getState();

  if (!isPlaying && video && segments.length > 0) {
    const last = segments[segments.length - 1];
    if (last && currentTime >= last.end - 1e-3) {
      seekVideo(video, segments[0]!.start);
    } else if (
      !segments.some((s) => currentTime >= s.start && currentTime <= s.end)
    ) {
      seekVideo(video, snapTimeToKeptRange(segments, currentTime));
    }
  }

  setPlaying(!isPlaying);
}

let lastPublishedMs = Number.NEGATIVE_INFINITY;
let pendingTime: number | null = null;
let pendingTimer = 0;

function clearPendingPlaybackPublish(): void {
  if (pendingTimer) {
    window.clearTimeout(pendingTimer);
    pendingTimer = 0;
  }
  pendingTime = null;
}

function commitPlaybackTime(time: number, nowMs: number): void {
  clearPendingPlaybackPublish();
  lastPublishedMs = nowMs;
  const { currentTime, setCurrentTime } = useEditorStore.getState();
  if (Math.abs(currentTime - time) < 1e-4) return;
  setCurrentTime(time);
}

/**
 * Push media time into the store. Pass `force` after seek / pause so the UI
 * clock matches the element immediately. While playing, publishes at
 * ~`PLAYBACK_UI_HZ` so Timeline/scrubbers do not reconcile every media tick.
 */
export function publishPlaybackTime(
  time: number,
  options: { force?: boolean } = {},
): void {
  const force = options.force === true;
  const now = performance.now();
  const playing = useEditorStore.getState().isPlaying;

  if (force || !playing) {
    commitPlaybackTime(time, now);
    return;
  }

  if (playbackUiDue(now, lastPublishedMs, false)) {
    commitPlaybackTime(time, now);
    return;
  }

  pendingTime = time;
  if (pendingTimer) return;
  const wait = Math.max(0, PLAYBACK_UI_INTERVAL_MS - (now - lastPublishedMs));
  pendingTimer = window.setTimeout(() => {
    pendingTimer = 0;
    const next = pendingTime;
    pendingTime = null;
    if (next == null) return;
    commitPlaybackTime(next, performance.now());
  }, wait);
}

/**
 * Force a decoded bitmap while paused. WKWebView often reports videoWidth after
 * `loadedmetadata` but canvas `drawImage(video)` stays black until Play or a
 * seek — which is why the editor opens showing only cursor + face-cam.
 */
const priming = new WeakMap<HTMLVideoElement, Promise<void>>();

export function primePausedVideoFrame(video: HTMLVideoElement): Promise<void> {
  const existing = priming.get(video);
  if (existing) return existing;

  if (video.readyState < HTMLMediaElement.HAVE_METADATA)
    return Promise.resolve();
  // A playing element decodes on its own — and priming it would rewind it.
  if (!video.paused) return Promise.resolve();
  // A live-muxed source reports `duration === Infinity`; taking that as "no
  // duration" left the face-cam's decoder asleep and its texture black.
  const duration = mediaDuration(video);
  if (duration <= 0) return Promise.resolve();

  const origin = video.currentTime;
  const atStart = origin < 1e-3;
  // One frame @ 30fps is enough to wake the decoder.
  const nudge = Math.min(
    1 / 30,
    Math.max(FIRST_PRESENTABLE_TIME, duration * 0.5),
  );
  // Never park at exact 0 after waking — same blank as before the nudge.
  const settle = presentableVideoTime(origin, duration);

  const task = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      priming.delete(video);
      resolve();
    };
    const timer = window.setTimeout(finish, 800);

    const seekOnce = (time: number) =>
      new Promise<void>((done) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          done();
        };
        video.addEventListener("seeked", onSeeked);
        // Always assign a different value so the engine emits `seeked`.
        const next =
          Math.abs(video.currentTime - time) < 1e-4
            ? Math.min(
                time + FIRST_PRESENTABLE_TIME,
                Math.max(0, duration - FIRST_PRESENTABLE_TIME),
              )
            : time;
        video.currentTime = next;
      });

    void (async () => {
      try {
        await seekOnce(atStart ? nudge : settle);
        // Playback can start while the nudge is in flight; the settle seek
        // would then rewind an element that is already rolling.
        if (atStart && video.paused) await seekOnce(settle);
      } finally {
        finish();
      }
    })();
  });

  priming.set(video, task);
  return task;
}

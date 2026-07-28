/**
 * UI clock rate for publishing `<video>` media time into the editor store.
 *
 * The compositor reads `video.currentTime` directly during play. The store copy
 * exists for React UI (scrubber label, crop freeze, history). Pushing every
 * media tick forces Timeline (and friends) to reconcile on the same thread as
 * the preview compositor — throttle while playing; flush on seek / pause.
 */

/** Store clock rate while playing — enough for scrubbers, cheap for React. */
export const PLAYBACK_UI_HZ = 10;
export const PLAYBACK_UI_INTERVAL_MS = 1000 / PLAYBACK_UI_HZ;

/** Pure gate used by the publisher and the self-check. */
export function playbackUiDue(
  nowMs: number,
  lastPublishedMs: number,
  force: boolean,
): boolean {
  return force || nowMs - lastPublishedMs >= PLAYBACK_UI_INTERVAL_MS;
}

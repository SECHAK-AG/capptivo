/**
 * Runnable check for the playback UI clock gate. Run:
 *   node --experimental-strip-types src/windows/editor/lib/playbackTime.selfcheck.ts
 */
import {
  PLAYBACK_UI_INTERVAL_MS,
  playbackUiDue,
} from "./playbackTime.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(playbackUiDue(0, Number.NEGATIVE_INFINITY, false) === true, "first publish due");
assert(playbackUiDue(50, 0, false) === false, "inside interval not due");
assert(
  playbackUiDue(PLAYBACK_UI_INTERVAL_MS, 0, false) === true,
  "at interval due",
);
assert(playbackUiDue(10, 0, true) === true, "force always due");

console.log("playbackTime.selfcheck: ok");

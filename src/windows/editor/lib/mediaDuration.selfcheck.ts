/** Selfcheck: mediaDuration. */

import { mediaDuration } from "./mediaDuration.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Stand-in for the two `HTMLMediaElement` fields `mediaDuration` reads. */
function media(duration: number, ...ranges: number[]) {
  return {
    duration,
    seekable: {
      length: ranges.length,
      end: (index: number) => ranges[index]!,
    },
  };
}

assert(mediaDuration(media(32, 32)) === 32, "declared duration wins");
// The MediaRecorder case: a live WebM reports Infinity until the engine hits EOF.
assert(
  mediaDuration(media(Number.POSITIVE_INFINITY, 6.212)) === 6.212,
  "Infinity falls back to the seekable end",
);
assert(mediaDuration(media(Number.NaN, 6.212)) === 6.212, "NaN falls back too");
assert(
  mediaDuration(media(Number.POSITIVE_INFINITY, 2, 6.212)) === 6.212,
  "the last seekable range is the end",
);
// Nothing buffered yet — callers must see 0 and skip, not seek to Infinity.
assert(mediaDuration(media(Number.POSITIVE_INFINITY)) === 0, "no ranges → 0");
assert(
  mediaDuration(media(Number.POSITIVE_INFINITY, 0)) === 0,
  "an empty seekable range is not a duration",
);
assert(mediaDuration(media(0)) === 0, "zero duration → 0");

console.log("mediaDuration.selfcheck: ok");

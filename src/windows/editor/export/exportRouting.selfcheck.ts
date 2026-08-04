/** Selfcheck: Path B export routing (pure). */

import { shouldPreferFfmpegRawvideoEncode } from "./exportRouting.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(
  shouldPreferFfmpegRawvideoEncode(false, true),
  "force flag selects Path B on non-Windows",
);
assert(
  shouldPreferFfmpegRawvideoEncode(true, false),
  "Windows prefers Path B",
);
assert(
  !shouldPreferFfmpegRawvideoEncode(false, false),
  "non-Windows keeps WebCodecs-first",
);

console.log("exportRouting.selfcheck: ok");

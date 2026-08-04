/** Selfcheck: MP4 export routing (pure). */

import {
  shouldAllowInWebviewMp4Mux,
  shouldForceFfmpegRawvideoEncode,
  shouldTryFfmpegRawvideoFallback,
} from "./exportRouting.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(
  shouldForceFfmpegRawvideoEncode(true),
  "force flag selects rawvideo first",
);
assert(
  !shouldForceFfmpegRawvideoEncode(false),
  "rawvideo is not the default without force",
);
assert(
  shouldTryFfmpegRawvideoFallback(false),
  "rawvideo remains a fallback when not already forced",
);
assert(
  !shouldTryFfmpegRawvideoFallback(true),
  "do not retry rawvideo after a forced attempt",
);
assert(
  !shouldAllowInWebviewMp4Mux(true),
  "Windows must not fall into in-webview MP4 mux",
);
assert(
  shouldAllowInWebviewMp4Mux(false),
  "non-Windows may use in-webview MP4 mux",
);

console.log("exportRouting.selfcheck: ok");

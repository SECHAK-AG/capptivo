/** Selfcheck: MP4 export routing (pure). */

import {
  annexBHardwareProbeOrder,
  shouldAllowInWebviewMp4Mux,
  shouldForceFfmpegRawvideoEncode,
  shouldTryFfmpegRawvideoFallback,
  shouldUseOffscreenExportCanvas,
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

const winHw = annexBHardwareProbeOrder(true);
assert(winHw[0] === "prefer-software", "Windows Annex-B starts software");
assert(!winHw.includes("prefer-hardware"), "Windows never probes HW WebCodecs");

const macHw = annexBHardwareProbeOrder(false);
assert(macHw[0] === "prefer-hardware", "macOS Annex-B prefers hardware");

assert(
  !shouldUseOffscreenExportCanvas({
    windows: true,
    sessionPreferDom: false,
  }),
  "Windows export uses DOM canvas",
);
assert(
  shouldUseOffscreenExportCanvas({
    windows: false,
    sessionPreferDom: false,
  }),
  "macOS may use OffscreenCanvas",
);
assert(
  !shouldUseOffscreenExportCanvas({
    windows: false,
    sessionPreferDom: true,
  }),
  "session latch forces DOM",
);
assert(
  !shouldUseOffscreenExportCanvas({
    windows: false,
    sessionPreferDom: false,
    optionOffscreen: false,
  }),
  "explicit offscreen:false forces DOM",
);

console.log("exportRouting.selfcheck: ok");

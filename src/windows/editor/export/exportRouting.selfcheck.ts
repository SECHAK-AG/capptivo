/** Selfcheck: MP4 export routing (pure). */

import {
  annexBHardwareProbeOrder,
  planMp4Routes,
  shouldUseOffscreenExportCanvas,
} from "./exportRouting.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const winHw = annexBHardwareProbeOrder(true);
assert(winHw[0] === "prefer-software", "Windows Annex-B starts software");
assert(
  !winHw.includes("prefer-hardware"),
  "Windows never probes prefer-hardware WebCodecs",
);

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

// The RGBA route needs no WebCodecs, so it must terminate every plan — that is
// the property that stops a machine from having no working route at all.
for (const annexBVerified of [true, false]) {
  for (const forceRgba of [true, false]) {
    for (const windows of [true, false]) {
      const routes = planMp4Routes({ windows, annexBVerified, forceRgba });
      assert(routes.length > 0, "a plan always has at least one route");
      assert(
        routes[routes.length - 1] === "rgba-ffmpeg",
        "every plan ends on the no-WebCodecs route",
      );
      assert(
        new Set(routes).size === routes.length,
        "a plan never repeats a route",
      );
    }
  }
}

// Windows is unconditional: WebView2's encoder wedges partway through a real
// export, so a verified probe result there is not evidence of anything.
for (const annexBVerified of [true, false]) {
  for (const forceRgba of [true, false]) {
    assert(
      planMp4Routes({ windows: true, annexBVerified, forceRgba }).join() ===
        "rgba-ffmpeg",
      "Windows never attempts Annex-B, even if an encoder verified",
    );
  }
}

assert(
  planMp4Routes({ windows: false, annexBVerified: true, forceRgba: false })[0] ===
    "annexb-ffmpeg",
  "a verified Annex-B encoder is used first off Windows",
);
assert(
  planMp4Routes({ windows: false, annexBVerified: false, forceRgba: false })
    .length === 1,
  "without a verified encoder there is nothing to try before RGBA",
);
assert(
  planMp4Routes({ windows: false, annexBVerified: true, forceRgba: true }).join() ===
    "rgba-ffmpeg",
  "the force override skips WebCodecs entirely",
);

console.log("exportRouting.selfcheck: ok");

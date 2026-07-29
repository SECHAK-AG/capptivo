/** Selfcheck: face-cam margin clamps, corner inset, and wallpaper cover framing. */

const MARGIN_MIN = 0;
const MARGIN_MAX = 96;
const DEFAULT_MARGIN = 24;

function resolveFaceCamMargin(marginPx: number): number {
  return Math.max(MARGIN_MIN, Math.min(MARGIN_MAX, marginPx));
}

function getFaceCamCornerPosition(
  width: number,
  height: number,
  camWidth: number,
  camHeight: number,
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right",
  marginPx: number,
): { x: number; y: number } {
  const margin = resolveFaceCamMargin(marginPx);
  return {
    x: corner === "top-left" || corner === "bottom-left" ? margin : width - camWidth - margin,
    y: corner === "top-left" || corner === "top-right" ? margin : height - camHeight - margin,
  };
}

/** Mirrors `coverDestRect` in editorCanvas.ts — keep in sync. */
function coverDestRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
): { x: number; y: number; width: number; height: number } {
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const tw = Math.max(1, destW);
  const th = Math.max(1, destH);
  const scale = Math.max(tw / sw, th / sh);
  const width = sw * scale;
  const height = sh * scale;
  return { x: (tw - width) / 2, y: (th - height) / 2, width, height };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(resolveFaceCamMargin(24) === 24, "margin 24");
assert(resolveFaceCamMargin(0) === 0, "margin 0");
assert(resolveFaceCamMargin(200) === 96, "margin clamp max");
assert(resolveFaceCamMargin(-5) === 0, "margin clamp min");

const br = getFaceCamCornerPosition(1000, 600, 200, 150, "bottom-right", 24);
assert(br.x === 1000 - 200 - 24, "bottom-right x");
assert(br.y === 600 - 150 - 24, "bottom-right y");

const tl = getFaceCamCornerPosition(1000, 600, 200, 150, "top-left", DEFAULT_MARGIN);
assert(tl.x === DEFAULT_MARGIN, "top-left x");
assert(tl.y === DEFAULT_MARGIN, "top-left y");

// 16:9 wallpaper into 9:16 stage — must cover both axes (no letterbox).
{
  const r = coverDestRect(1920, 1080, 1080, 1920);
  assert(r.width >= 1080 - 1e-6, "portrait cover width");
  assert(r.height >= 1920 - 1e-6, "portrait cover height");
  assert(Math.abs(r.x + r.width / 2 - 540) < 1e-6, "portrait cover centered x");
}

// Wide wallpaper into square — cover both axes.
{
  const r = coverDestRect(1920, 1080, 1080, 1080);
  assert(r.width >= 1080 - 1e-6, "square cover width");
  assert(r.height >= 1080 - 1e-6, "square cover height");
}

// Same aspect — exact fill, no crop offset.
{
  const r = coverDestRect(1920, 1080, 1920, 1080);
  assert(Math.abs(r.x) < 1e-6 && Math.abs(r.y) < 1e-6, "matched aspect origin");
  assert(Math.abs(r.width - 1920) < 1e-6 && Math.abs(r.height - 1080) < 1e-6, "matched aspect size");
}

console.log("editorCanvas.selfcheck: ok");

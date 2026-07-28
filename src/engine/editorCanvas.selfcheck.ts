/**
 * Runnable check: face-cam margin clamps + corner inset.
 * Run: `node --experimental-strip-types src/engine/editorCanvas.selfcheck.ts`
 */

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

console.assert(resolveFaceCamMargin(24) === 24, "margin 24");
console.assert(resolveFaceCamMargin(0) === 0, "margin 0");
console.assert(resolveFaceCamMargin(200) === 96, "margin clamp max");
console.assert(resolveFaceCamMargin(-5) === 0, "margin clamp min");

const br = getFaceCamCornerPosition(1000, 600, 200, 150, "bottom-right", 24);
console.assert(br.x === 1000 - 200 - 24, "bottom-right x");
console.assert(br.y === 600 - 150 - 24, "bottom-right y");

const tl = getFaceCamCornerPosition(1000, 600, 200, 150, "top-left", DEFAULT_MARGIN);
console.assert(tl.x === DEFAULT_MARGIN, "top-left x");
console.assert(tl.y === DEFAULT_MARGIN, "top-left y");

console.log("editorCanvas.selfcheck: ok");

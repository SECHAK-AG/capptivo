/**
 * Corner-handle helpers for the crop/zoom reference-frame UIs (screen content
 * crop, zoom fixed-rect). Ported from the web editor's `lib/editorCanvas.ts`.
 */

export { getHandleCursor, hitTestHandle } from "@/engine";

export const CROP_HANDLE_SIZE = 14;

type NormRect = { x: number; y: number; width: number; height: number };
type CornerHandleId = "nw" | "ne" | "se" | "sw";

function handleInsetBasePx(handleSize: number): number {
  return Math.max(2, Math.round(handleSize * 0.22));
}

/** Slightly wider than tall so corners read as rectangles, not circles. */
function cornerHandlePixelDimensions(handleSize: number): { width: number; height: number } {
  return {
    width: Math.round(handleSize + 2),
    height: Math.max(8, Math.round(handleSize - 2)),
  };
}

/**
 * CSS position/size for a corner handle overlay (percent of stage + px inset).
 */
export function cornerHandleOverlayStyle(
  norm: NormRect,
  corner: CornerHandleId,
  handleSize: number,
): { left: string; top: string; width: number; height: number } {
  const inset = handleInsetBasePx(handleSize);
  const { width: hw, height: hh } = cornerHandlePixelDimensions(handleSize);
  const rx = norm.x + norm.width;
  const by = norm.y + norm.height;

  switch (corner) {
    case "nw":
      return {
        left: `calc(${norm.x * 100}% + ${inset}px)`,
        top: `calc(${norm.y * 100}% + ${inset}px)`,
        width: hw,
        height: hh,
      };
    case "ne":
      return {
        left: `calc(${rx * 100}% - ${inset + hw}px)`,
        top: `calc(${norm.y * 100}% + ${inset}px)`,
        width: hw,
        height: hh,
      };
    case "sw":
      return {
        left: `calc(${norm.x * 100}% + ${inset}px)`,
        top: `calc(${by * 100}% - ${inset + hh}px)`,
        width: hw,
        height: hh,
      };
    case "se":
      return {
        left: `calc(${rx * 100}% - ${inset + hw}px)`,
        top: `calc(${by * 100}% - ${inset + hh}px)`,
        width: hw,
        height: hh,
      };
  }
}

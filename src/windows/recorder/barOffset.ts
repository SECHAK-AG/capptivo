/** Clamp a CSS-drag offset so the bar stays inside the work-area overlay. */

export interface BarOffset {
  x: number;
  y: number;
}

export interface BarBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function clampAxis(
  offset: number,
  start: number,
  end: number,
  viewportSize: number,
): number {
  if (start < 0) return offset - start;
  if (end > viewportSize) return offset + viewportSize - end;
  return offset;
}

export function clampBarOffset(
  offset: BarOffset,
  bounds: BarBounds,
  viewport: { width: number; height: number },
): BarOffset {
  return {
    x: clampAxis(offset.x, bounds.left, bounds.right, viewport.width),
    y: clampAxis(offset.y, bounds.top, bounds.bottom, viewport.height),
  };
}

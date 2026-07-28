import type { HistoryItem, Point } from "./types";

export type BBox = { minX: number; minY: number; maxX: number; maxY: number };

function inflate(b: BBox, pad: number): BBox {
  return {
    minX: b.minX - pad,
    minY: b.minY - pad,
    maxX: b.maxX + pad,
    maxY: b.maxY + pad,
  };
}

function intersects(a: BBox, b: BBox): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY
  );
}

export function pointsBBox(points: Point[], pad: number): BBox | null {
  if (points.length === 0) {
    return null;
  }
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return inflate({ minX, minY, maxX, maxY }, pad);
}

export function historyItemBBox(item: HistoryItem): BBox | null {
  switch (item.kind) {
    case "path":
      return pointsBBox(item.points, item.width / 2 + 2);
    case "pixelErase":
      return pointsBBox(item.points, item.radius + 2);
    case "shape": {
      const minX = Math.min(item.x0, item.x1);
      const maxX = Math.max(item.x0, item.x1);
      const minY = Math.min(item.y0, item.y1);
      const maxY = Math.max(item.y0, item.y1);
      return inflate(
        { minX, minY, maxX, maxY },
        item.width / 2 + 4,
      );
    }
    case "text": {
      const w = Math.max(80, item.text.length * item.fontSize * 0.55);
      const h = item.fontSize * 1.35;
      return {
        minX: item.x - 4,
        minY: item.y - 4,
        maxX: item.x + w + 4,
        maxY: item.y + h + 4,
      };
    }
    default:
      return null;
  }
}

export function eraserStrokeRemovals(
  history: HistoryItem[],
  eraserPoints: Point[],
  eraserWidth: number,
): HistoryItem[] {
  const eb = pointsBBox(eraserPoints, eraserWidth / 2 + 6);
  if (!eb) {
    return history;
  }
  return history.filter((item) => {
    const ib = historyItemBBox(item);
    if (!ib) {
      return true;
    }
    return !intersects(ib, eb);
  });
}

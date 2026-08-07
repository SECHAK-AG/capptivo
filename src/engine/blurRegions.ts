export type BlurRegion = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BlurRegionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BlurRegionPlacement = {
  source: BlurRegionRect;
  dest: BlurRegionRect;
};

export const BLUR_REGION_MIN_SIZE = 0.02;

export const BLUR_REGION_STRENGTH = 18;

export function createBlurRegionId(): string {
  return `blur-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampBlurRegion(region: BlurRegion): BlurRegion {
  const width = clamp(
    Number.isFinite(region.width) ? region.width : BLUR_REGION_MIN_SIZE,
    BLUR_REGION_MIN_SIZE,
    1,
  );
  const height = clamp(
    Number.isFinite(region.height) ? region.height : BLUR_REGION_MIN_SIZE,
    BLUR_REGION_MIN_SIZE,
    1,
  );
  return {
    id: region.id,
    x: clamp(Number.isFinite(region.x) ? region.x : 0, 0, 1 - width),
    y: clamp(Number.isFinite(region.y) ? region.y : 0, 0, 1 - height),
    width,
    height,
  };
}

export function createBlurRegion(): BlurRegion {
  return {
    id: createBlurRegionId(),
    x: 0.3,
    y: 0.4,
    width: 0.25,
    height: 0.12,
  };
}

export function blurRegionPlacement(
  region: BlurRegion,
  sourceWidth: number,
  sourceHeight: number,
  content: { ox: number; oy: number; rw: number; rh: number },
  rect: BlurRegionRect,
): BlurRegionPlacement | null {
  if (
    !(sourceWidth > 0) ||
    !(sourceHeight > 0) ||
    !(content.rw > 0) ||
    !(content.rh > 0) ||
    !(rect.width > 0) ||
    !(rect.height > 0)
  ) {
    return null;
  }

  const safe = clampBlurRegion(region);
  const left = Math.max(safe.x * sourceWidth, content.ox);
  const top = Math.max(safe.y * sourceHeight, content.oy);
  const right = Math.min(
    (safe.x + safe.width) * sourceWidth,
    content.ox + content.rw,
  );
  const bottom = Math.min(
    (safe.y + safe.height) * sourceHeight,
    content.oy + content.rh,
  );

  if (!(right > left) || !(bottom > top)) {
    return null;
  }

  const scaleX = rect.width / content.rw;
  const scaleY = rect.height / content.rh;

  return {
    source: { x: left, y: top, width: right - left, height: bottom - top },
    dest: {
      x: rect.x + (left - content.ox) * scaleX,
      y: rect.y + (top - content.oy) * scaleY,
      width: (right - left) * scaleX,
      height: (bottom - top) * scaleY,
    },
  };
}

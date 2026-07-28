export type ContentRectPixels = {
  ox: number;
  oy: number;
  rw: number;
  rh: number;
};

export type ScreenVideoCropOptions = {
  bottomCropPx?: number;
  /** Source pixel sub-rect treated as the visible screen (NDC 0–1 inside it). */
  contentRectPixels?: ContentRectPixels;
};

/** Source pixel crop for zoomed screen video. */
export function computeVideoZoomCrop(
  sourceWidth: number,
  sourceHeight: number,
  scale: number,
  center: { x: number; y: number },
  options?: ScreenVideoCropOptions,
): { sourceX: number; sourceY: number; cropWidth: number; cropHeight: number } {
  const sw = Math.max(1, sourceWidth || 1);
  const sh = Math.max(1, sourceHeight || 1);
  const crp = options?.contentRectPixels;

  if (crp && crp.rw > 0 && crp.rh > 0) {
    const Wc = Math.max(1, crp.rw);
    const Hc = Math.max(1, crp.rh);
    const safeScale = Math.max(1, scale);
    const cropWidth = Wc / safeScale;
    const cropHeight = Hc / safeScale;
    const rawSourceX = crp.ox + center.x * Wc - cropWidth / 2;
    const rawSourceY = crp.oy + center.y * Hc - cropHeight / 2;
    return {
      cropWidth,
      cropHeight,
      sourceX: Math.min(Math.max(crp.ox, rawSourceX), crp.ox + Wc - cropWidth),
      sourceY: Math.min(Math.max(crp.oy, rawSourceY), crp.oy + Hc - cropHeight),
    };
  }

  const maxBottomCrop = Math.max(0, sh - 1);
  const bottomCropPx = Math.max(
    0,
    Math.min(maxBottomCrop, Math.round(Number(options?.bottomCropPx ?? 0) || 0)),
  );
  const visibleSourceHeight = Math.max(1, sh - bottomCropPx);
  const safeScale = Math.max(1, scale);
  const cropWidth = sw / safeScale;
  const cropHeight = visibleSourceHeight / safeScale;
  const rawSourceX = center.x * sw - cropWidth / 2;
  const rawSourceY = center.y * visibleSourceHeight - cropHeight / 2;
  return {
    cropWidth,
    cropHeight,
    sourceX: Math.min(Math.max(0, rawSourceX), sw - cropWidth),
    sourceY: Math.min(Math.max(0, rawSourceY), visibleSourceHeight - cropHeight),
  };
}

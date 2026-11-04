/** Preview raster budget only; composition units and export resolution stay intact. */
export function previewOutputSize(stageWidth: number, stageHeight: number, cssWidth: number, cssHeight: number, dpr = 1): { width: number; height: number } {
  const density = Math.min(1.5, Math.max(1, Number.isFinite(dpr) ? dpr : 1));
  const visible = cssWidth > 0 && cssHeight > 0 ? Math.min(cssWidth / stageWidth, cssHeight / stageHeight) * density : 1;
  const scale = Math.min(1, visible, 1280 / Math.max(stageWidth, stageHeight));
  return { width: Math.max(1, Math.round(stageWidth * scale)), height: Math.max(1, Math.round(stageHeight * scale)) };
}

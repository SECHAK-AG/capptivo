/**
 * Probe whether Canvas-2D `filter: blur()` works (WKWebView no-op fallback).
 */
let nativeBlurProbe: boolean | null = null;

export function nativeCanvasBlurWorks(): boolean {
  if (nativeBlurProbe !== null) return nativeBlurProbe;
  const probe = document.createElement("canvas");
  probe.width = 16;
  probe.height = 16;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return (nativeBlurProbe = false);
  ctx.filter = "blur(2px)";
  ctx.fillStyle = "#fff";
  ctx.fillRect(6, 6, 4, 4);
  return (nativeBlurProbe = ctx.getImageData(3, 8, 1, 1).data[3] > 0);
}

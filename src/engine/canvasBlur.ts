/**
 * Is Canvas-2D `filter: blur()` real on this platform?
 *
 * WKWebView parses the property but renders the blur as a no-op, which showed
 * up as "barely blurs and looks pixelated" on the background layer and as a
 * hard black slab behind the recording. Everything that blurs on a 2D canvas
 * has to ask first and fall back to `gaussianBlurRgba`.
 *
 * Probe with a real draw: a working blur bleeds alpha outside the filled rect,
 * a no-op leaves the probe pixel empty. Cached — the answer cannot change
 * within a session.
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

/** Kernel pad for canvas `blur(Npx)` so edges don't fade to transparent. */
export function backgroundBlurPad(blurPx: number): number {
  const b = Math.max(0, blurPx);
  return b <= 0 ? 0 : Math.ceil(b * 2);
}

/** Largest radius blurred at full resolution before downscaling kicks in. */
const FULL_RES_MAX_BLUR = 12;

/** Floor so extreme radii never upscale from a blocky thumbnail. */
const MIN_BLUR_SCALE = 0.25;

/**
 * Downscale offscreen blur past {@link FULL_RES_MAX_BLUR} — blur hides the upscale.
 */
export function backgroundBlurScale(blurPx: number): number {
  const b = Math.max(0, blurPx);
  if (b <= FULL_RES_MAX_BLUR) return 1;
  return Math.max(MIN_BLUR_SCALE, FULL_RES_MAX_BLUR / b);
}

/**
 * CPU Gaussian blur for RGBA pixel buffers — fallback for webviews where the
 * Canvas-2D `filter` property parses but renders as a no-op (WKWebView).
 * Three chained box blurs converge on a true Gaussian (central limit
 * theorem), and each pass is O(pixels) via a sliding window, so cost is
 * independent of radius.
 */

/** Odd box widths whose successive passes approximate a Gaussian of `sigma`. */
export function boxSizesForGaussian(sigma: number, passes = 3): number[] {
  // Ivan Kutskir, "Fastest Gaussian blur": ideal averaging-filter width for
  // `passes` boxes, split between the two nearest odd widths.
  const s = Math.max(0, sigma);
  const wIdeal = Math.sqrt((12 * s * s) / passes + 1);
  let lower = Math.floor(wIdeal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const mIdeal =
    (12 * s * s - passes * lower * lower - 4 * passes * lower - 3 * passes) /
    (-4 * lower - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: passes }, (_, i) => (i < m ? lower : upper));
}

/**
 * One clamped horizontal box-blur pass, `src` → `dst`. Each row is swept once
 * with the four channel accumulators held in locals — per-channel row walks
 * would read the row four times over.
 */
function boxBlurH(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const norm = 1 / (radius * 2 + 1);
  const rowLen = width * 4;

  for (let y = 0; y < height; y++) {
    const row = y * rowLen;
    // Window centered at x=0: out-of-range samples clamp to the first texel.
    let a0 = radius * src[row];
    let a1 = radius * src[row + 1];
    let a2 = radius * src[row + 2];
    let a3 = radius * src[row + 3];
    for (let i = 0; i <= radius; i++) {
      const p = row + Math.min(i, width - 1) * 4;
      a0 += src[p];
      a1 += src[p + 1];
      a2 += src[p + 2];
      a3 += src[p + 3];
    }
    dst[row] = a0 * norm;
    dst[row + 1] = a1 * norm;
    dst[row + 2] = a2 * norm;
    dst[row + 3] = a3 * norm;

    for (let x = 1; x < width; x++) {
      const add = row + Math.min(x + radius, width - 1) * 4;
      const sub = row + Math.max(x - radius - 1, 0) * 4;
      const out = row + x * 4;
      a0 += src[add] - src[sub];
      a1 += src[add + 1] - src[sub + 1];
      a2 += src[add + 2] - src[sub + 2];
      a3 += src[add + 3] - src[sub + 3];
      dst[out] = a0 * norm;
      dst[out + 1] = a1 * norm;
      dst[out + 2] = a2 * norm;
      dst[out + 3] = a3 * norm;
    }
  }
}

/**
 * One clamped vertical box-blur pass, `src` → `dst`. Slides a whole row of
 * accumulators down the image so every read/write is sequential — a per-column
 * walk would stride `width*4` floats per sample and thrash the cache.
 */
function boxBlurV(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const rowLen = width * 4;
  const norm = 1 / (radius * 2 + 1);
  const acc = new Float32Array(rowLen);

  // Window centered at y=0: out-of-range rows clamp to the first row.
  for (let i = 0; i < rowLen; i++) acc[i] = radius * src[i];
  for (let y = 0; y <= radius; y++) {
    const off = Math.min(y, height - 1) * rowLen;
    for (let i = 0; i < rowLen; i++) acc[i] += src[off + i];
  }
  for (let i = 0; i < rowLen; i++) dst[i] = acc[i] * norm;

  for (let y = 1; y < height; y++) {
    const addOff = Math.min(y + radius, height - 1) * rowLen;
    const subOff = Math.max(y - radius - 1, 0) * rowLen;
    const dstOff = y * rowLen;
    for (let i = 0; i < rowLen; i++) {
      acc[i] += src[addOff + i] - src[subOff + i];
      dst[dstOff + i] = acc[i] * norm;
    }
  }
}

/** In-place Gaussian blur of an RGBA buffer (e.g. `ImageData.data`). */
export function gaussianBlurRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  sigma: number,
): void {
  if (sigma <= 0 || width < 1 || height < 1) return;
  const a = new Float32Array(data);
  const b = new Float32Array(data.length);
  for (const size of boxSizesForGaussian(sigma)) {
    const radius = (size - 1) / 2;
    if (radius <= 0) continue;
    boxBlurH(a, b, width, height, radius);
    boxBlurV(b, a, width, height, radius);
  }
  data.set(a);
}

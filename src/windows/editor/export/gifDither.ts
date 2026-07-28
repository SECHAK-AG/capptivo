/**
 * Floyd–Steinberg error-diffusion palette mapping for GIF frames.
 *
 * gifenc's `applyPalette` maps each pixel to its nearest palette colour with no
 * error diffusion, so smooth content — blurred backgrounds, drop shadows,
 * camera vignettes — bands into hard stair-steps once it is crushed to 256
 * colours. Diffusing the quantization error into the neighbouring pixels turns
 * that banding into fine dither noise the eye integrates back into a smooth
 * gradient, dramatically improving perceived quality at the same colour limit.
 *
 * Scanning is serpentine (alternating row direction) to avoid the directional
 * "worm" artefacts a fixed left-to-right pass leaves on flat regions.
 */

type Rgb = number[]; // [r, g, b] (gifenc palette entry)

function nearestColorIndexRGB(r: number, g: number, b: number, palette: Rgb[]): number {
  let best = 0;
  let min = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i]!;
    let d = (p[0]! - r) * (p[0]! - r);
    if (d >= min) continue;
    d += (p[1]! - g) * (p[1]! - g);
    if (d >= min) continue;
    d += (p[2]! - b) * (p[2]! - b);
    if (d >= min) continue;
    min = d;
    best = i;
  }
  return best;
}

/**
 * Build a reusable dithering palettizer for one frame geometry. The working
 * buffers are allocated once and reused across every frame of the export.
 */
export function createDitherPalettizer(width: number, height: number) {
  const count = width * height;
  // Signed working buffer: diffused error can push a channel below 0 or past 255.
  const buf = new Float32Array(count * 3);
  const index = new Uint8Array(count);

  return function ditherApplyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Rgb[],
  ): Uint8Array {
    // Seed the working buffer from the frame's RGB (alpha ignored — opaque here).
    for (let i = 0, j = 0; i < count; i++, j += 4) {
      const k = i * 3;
      buf[k] = rgba[j]!;
      buf[k + 1] = rgba[j + 1]!;
      buf[k + 2] = rgba[j + 2]!;
    }

    // Cache nearest-colour lookups by rgb565 key — the dither perturbations stay
    // small, so most pixels reuse a cached index while keeping the noise.
    const cache: Int16Array = new Int16Array(65536).fill(-1);

    for (let y = 0; y < height; y++) {
      const rowStart = y * width;
      const leftToRight = (y & 1) === 0;
      const xStart = leftToRight ? 0 : width - 1;
      const xEnd = leftToRight ? width : -1;
      const step = leftToRight ? 1 : -1;

      for (let x = xStart; x !== xEnd; x += step) {
        const p = (rowStart + x) * 3;
        const r = buf[p]!;
        const g = buf[p + 1]!;
        const b = buf[p + 2]!;

        const cr = r < 0 ? 0 : r > 255 ? 255 : r | 0;
        const cg = g < 0 ? 0 : g > 255 ? 255 : g | 0;
        const cb = b < 0 ? 0 : b > 255 ? 255 : b | 0;
        const key = ((cr >> 3) << 11) | ((cg >> 2) << 5) | (cb >> 3);

        let idx = cache[key]!;
        if (idx < 0) {
          idx = nearestColorIndexRGB(cr, cg, cb, palette);
          cache[key] = idx;
        }
        index[rowStart + x] = idx;

        const pal = palette[idx]!;
        // Error against the unclamped source so it is conserved as it diffuses.
        const er = (r - pal[0]!) / 16;
        const eg = (g - pal[1]!) / 16;
        const eb = (b - pal[2]!) / 16;

        const fwd = x + step; // forward neighbour on this row
        const back = x - step; // back-diagonal on the next row
        if (fwd >= 0 && fwd < width) {
          const q = (rowStart + fwd) * 3;
          buf[q] += er * 7;
          buf[q + 1] += eg * 7;
          buf[q + 2] += eb * 7;
        }
        if (y + 1 < height) {
          const nextRow = rowStart + width;
          if (back >= 0 && back < width) {
            const q = (nextRow + back) * 3;
            buf[q] += er * 3;
            buf[q + 1] += eg * 3;
            buf[q + 2] += eb * 3;
          }
          const qd = (nextRow + x) * 3;
          buf[qd] += er * 5;
          buf[qd + 1] += eg * 5;
          buf[qd + 2] += eb * 5;
          if (fwd >= 0 && fwd < width) {
            const q = (nextRow + fwd) * 3;
            buf[q] += er;
            buf[q + 1] += eg;
            buf[q + 2] += eb;
          }
        }
      }
    }

    return index;
  };
}

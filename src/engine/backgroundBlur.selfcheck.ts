/** Selfcheck: blur pad and downscale math. */

import { backgroundBlurPad, backgroundBlurScale } from "./backgroundBlurPad.ts";
import { boxSizesForGaussian, gaussianBlurRgba } from "./gaussianBlur.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Pad grows with blur (edge samples for the kernel) but must not imply content
// zoom — the old path drew at w+6×blur which looked like a zoom slider.
assert(backgroundBlurPad(0) === 0, "no pad when blur is 0");
assert(backgroundBlurPad(9) === 18, "default blur pad");
assert(backgroundBlurPad(60) === 120, "max slider blur pad");
assert(backgroundBlurPad(-3) === 0, "negative blur clamps");

// The blur pass renders at reduced resolution once the radius exceeds what
// full-res detail can survive; the scale must never zoom (it only shrinks the
// offscreen pass, geometry still maps w×h → w×h).
assert(backgroundBlurScale(0) === 1, "no downscale when blur is 0");
assert(backgroundBlurScale(9) === 1, "default blur stays full-res");
assert(backgroundBlurScale(12) === 1, "threshold blur stays full-res");
assert(backgroundBlurScale(24) === 0.5, "2× threshold halves resolution");
assert(backgroundBlurScale(60) === 0.25, "max slider blur hits the floor");
assert(backgroundBlurScale(-3) === 1, "negative blur clamps");
for (let b = 1; b < 60; b++) {
  assert(
    backgroundBlurScale(b + 1) <= backgroundBlurScale(b),
    `scale must be non-increasing (blur ${b})`,
  );
  const s = backgroundBlurScale(b);
  assert(s > 0 && s <= 1, `scale in (0, 1] (blur ${b})`);
}

// Box-blur chain: odd widths approximating a Gaussian, identity at sigma 0.
{
  const identity = boxSizesForGaussian(0);
  assert(
    identity.length === 3 && identity.every((w) => w === 1),
    "sigma 0 → identity boxes",
  );
  for (const sigma of [0.5, 2, 15, 60]) {
    const boxes = boxSizesForGaussian(sigma);
    assert(boxes.length === 3, `three passes (sigma ${sigma})`);
    assert(
      boxes.every((w) => w >= 1 && w % 2 === 1),
      `odd box widths (sigma ${sigma})`,
    );
  }
}

// CPU blur: sigma 0 is a no-op and a uniform image must stay uniform — any
// edge darkening here would show as a vignette on the real background.
{
  const W = 16;
  const H = 12;
  const uniform = new Uint8ClampedArray(W * H * 4).fill(128);
  gaussianBlurRgba(uniform, W, H, 0);
  assert(
    uniform.every((v) => v === 128),
    "sigma 0 leaves pixels untouched",
  );
  gaussianBlurRgba(uniform, W, H, 4);
  assert(
    uniform.every((v) => v === 128),
    "uniform image stays uniform (clamped edges)",
  );
}

// CPU blur: an impulse spreads symmetrically and larger sigma flattens more.
function blurredImpulsePeak(sigma: number): {
  peak: number;
  left: number;
  right: number;
  up: number;
  down: number;
} {
  const W = 17;
  const H = 17;
  const px = new Uint8ClampedArray(W * H * 4);
  const at = (x: number, y: number) => (y * W + x) * 4;
  px[at(8, 8)] = 255;
  gaussianBlurRgba(px, W, H, sigma);
  return {
    peak: px[at(8, 8)],
    left: px[at(7, 8)],
    right: px[at(9, 8)],
    up: px[at(8, 7)],
    down: px[at(8, 9)],
  };
}

{
  const soft = blurredImpulsePeak(1);
  assert(soft.peak > 0 && soft.peak < 255, "impulse peak attenuated");
  assert(soft.left === soft.right && soft.up === soft.down, "spread symmetric");
  assert(soft.left > 0, "impulse energy spreads to neighbours");
  const wide = blurredImpulsePeak(4);
  assert(wide.peak < soft.peak, "larger sigma flattens the peak further");
}

console.log("backgroundBlur.selfcheck: ok");

/**
 * Baked drop-shadow sprites for the rounded rects in the composition (the
 * recording frame, the face-cam PiP).
 *
 * A shadow here is a **stack of blurred silhouettes** of the rect it sits
 * behind — the Canvas-2D translation of a multi-layer CSS `box-shadow`, and
 * the reason the falloff reads as a gradient: one broad ambient pass carries
 * the spread, tighter passes darken the contact edge. A single pass, whatever
 * its blur, only ever reads as a flat dark halo.
 *
 * Nothing paints the rect itself. The passes are silhouettes that are *only*
 * blurred, so the sprite has no opaque core that a sub-pixel mismatch with the
 * video on top of it could expose as a hard black edge.
 *
 * Blur is expensive and a shadow depends on nothing that changes per frame —
 * rect size, corner radius, intensity — so callers bake once behind a key and
 * blit the sprite every frame. Bakes still run every frame of a slider drag,
 * which is why the sprite is rendered at reduced resolution: blurred output
 * carries no detail finer than its sigma, so the upscale is invisible.
 */

import { nativeCanvasBlurWorks } from "./canvasBlur";
import { gaussianBlurRgba } from "./gaussianBlur";
import { roundedRectPath } from "./roundedRect";

/** One blurred silhouette in the stack. */
export interface ShadowPass {
  /** Gaussian standard deviation, in stage px — CSS `blur(<sigma>px)`. */
  sigma: number;
  /** Peak opacity of the silhouette, before it is blurred. */
  opacity: number;
  /** Displacement from the rect. Omit both for a shadow centred on it. */
  offsetX?: number;
  offsetY?: number;
}

export interface ShadowSprite {
  canvas: HTMLCanvasElement;
  /** Margin the shadow needs around the rect, in stage px. */
  pad: number;
  /** Blit size in stage px — the canvas itself may be baked smaller. */
  width: number;
  height: number;
}

/** A Gaussian is ~99.7% contained within 3 sigma; the tail past that is invisible. */
const SIGMA_REACH = 3;

/** Device-px sigma the tightest pass keeps once the sprite is downscaled. */
const MIN_BAKED_SIGMA = 3;

/** Floor so an extreme radius never upscales from a blocky thumbnail. */
const MIN_BAKE_SCALE = 0.25;

/** The CPU fallback costs O(area), so cap its buffer harder than the native path. */
const CPU_BAKE_MAX_DIM = 720;

/** Reused across bakes — on WKWebView the fallback path runs on every drag frame. */
let scratchCanvas: HTMLCanvasElement | null = null;

/** The fallback path round-trips pixels through `getImageData`. */
const READBACK_CONTEXT: CanvasRenderingContext2DSettings = {
  willReadFrequently: true,
};

function sizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return canvas;
}

/**
 * Bake `passes` behind a `w`×`h` rounded rect of radius `r` into an offscreen
 * canvas. The rect sits at `(pad, pad)` in stage px, so blit the sprite at
 * `(rectX - pad, rectY - pad)` sized `width`×`height`.
 *
 * Reuses `into` when passed (resized in place).
 */
export function renderRoundedRectShadowSprite(
  into: HTMLCanvasElement | null,
  w: number,
  h: number,
  r: number,
  passes: readonly ShadowPass[],
): ShadowSprite {
  // Tightest first: the fallback path blurs one silhouette progressively, and
  // stacking black-on-black with `source-over` commutes, so the order is free.
  const live = passes
    .filter((p) => p.opacity > 0 && p.sigma >= 0)
    .sort((a, b) => a.sigma - b.sigma);

  let pad = 0;
  for (const p of live) {
    const drift = Math.max(Math.abs(p.offsetX ?? 0), Math.abs(p.offsetY ?? 0));
    pad = Math.max(pad, p.sigma * SIGMA_REACH + drift);
  }
  pad = Math.ceil(pad);

  // Sorted ascending, so the first pass is the one that sets the detail floor.
  const tightest = live.length > 0 ? live[0].sigma : 0;

  const boxWidth = w + pad * 2;
  const boxHeight = h + pad * 2;
  const native = nativeCanvasBlurWorks();

  let scale = tightest > MIN_BAKED_SIGMA ? MIN_BAKED_SIGMA / tightest : 1;
  if (!native) {
    scale = Math.min(scale, CPU_BAKE_MAX_DIM / Math.max(boxWidth, boxHeight));
  }
  scale = Math.min(1, Math.max(MIN_BAKE_SCALE, scale));

  const bakedWidth = Math.max(1, Math.ceil(boxWidth * scale));
  const bakedHeight = Math.max(1, Math.ceil(boxHeight * scale));
  const canvas = sizeCanvas(
    into ?? document.createElement("canvas"),
    bakedWidth,
    bakedHeight,
  );
  const sprite: ShadowSprite = {
    canvas,
    pad,
    width: bakedWidth / scale,
    height: bakedHeight / scale,
  };

  const ctx = canvas.getContext("2d");
  if (!ctx) return sprite;
  ctx.clearRect(0, 0, bakedWidth, bakedHeight);
  if (live.length === 0) return sprite;

  // Geometry is written straight in device px rather than through a canvas
  // transform: `filter` lengths live in canvas space and ignore the CTM, so
  // scaling every number by hand is the only unambiguous form.
  const rectX = pad * scale;
  const rectY = pad * scale;
  const rectW = w * scale;
  const rectH = h * scale;
  const rectR = Math.max(0, Math.min(r * scale, Math.min(rectW, rectH) / 2));

  if (native) {
    for (const p of live) {
      ctx.filter = p.sigma > 0 ? `blur(${p.sigma * scale}px)` : "none";
      ctx.fillStyle = `rgba(0, 0, 0, ${p.opacity})`;
      roundedRectPath(
        ctx,
        rectX + (p.offsetX ?? 0) * scale,
        rectY + (p.offsetY ?? 0) * scale,
        rectW,
        rectH,
        rectR,
      );
      ctx.fill();
    }
    ctx.filter = "none";
    return sprite;
  }

  const scratch = sizeCanvas(
    (scratchCanvas ??= document.createElement("canvas")),
    bakedWidth,
    bakedHeight,
  );
  const scratchCtx = scratch.getContext("2d", READBACK_CONTEXT);
  if (!scratchCtx) return sprite;

  // One opaque silhouette serves every pass: blur is linear, so blurring at
  // full strength and blitting at `opacity` is the same picture the native
  // path draws by filling at `opacity` and blurring that. It is also why the
  // silhouette has to be black — `gaussianBlurRgba` blurs un-premultiplied
  // channels, which only leaves colour untouched when there is none.
  scratchCtx.clearRect(0, 0, bakedWidth, bakedHeight);
  scratchCtx.fillStyle = "#000";
  roundedRectPath(scratchCtx, rectX, rectY, rectW, rectH, rectR);
  scratchCtx.fill();

  // Chaining Gaussians of sigma a then b is a Gaussian of sqrt(a² + b²), so
  // each pass pays only for the spread it adds over the pass before it.
  const frame = scratchCtx.getImageData(0, 0, bakedWidth, bakedHeight);
  let blurred = 0;
  for (const p of live) {
    const sigma = p.sigma * scale;
    gaussianBlurRgba(
      frame.data,
      bakedWidth,
      bakedHeight,
      Math.sqrt(Math.max(0, sigma * sigma - blurred * blurred)),
    );
    blurred = sigma;
    scratchCtx.putImageData(frame, 0, 0);
    ctx.globalAlpha = p.opacity;
    ctx.drawImage(scratch, (p.offsetX ?? 0) * scale, (p.offsetY ?? 0) * scale);
  }
  ctx.globalAlpha = 1;
  return sprite;
}

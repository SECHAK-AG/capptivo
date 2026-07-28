/**
 * Baked drop-shadow sprites for rounded rects (recording frame, face-cam PiP).
 * Multi-pass blurred silhouettes; bake once, blit each frame.
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

/** Bake shadow passes behind a `w`×`h` rounded rect; blit at `(rectX - pad, rectY - pad)`. */
export function renderRoundedRectShadowSprite(
  into: HTMLCanvasElement | null,
  w: number,
  h: number,
  r: number,
  passes: readonly ShadowPass[],
): ShadowSprite {
  const live = passes
    .filter((p) => p.opacity > 0 && p.sigma >= 0)
    .sort((a, b) => a.sigma - b.sigma);

  let pad = 0;
  for (const p of live) {
    const drift = Math.max(Math.abs(p.offsetX ?? 0), Math.abs(p.offsetY ?? 0));
    pad = Math.max(pad, p.sigma * SIGMA_REACH + drift);
  }
  pad = Math.ceil(pad);

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

  scratchCtx.clearRect(0, 0, bakedWidth, bakedHeight);
  scratchCtx.fillStyle = "#000";
  roundedRectPath(scratchCtx, rectX, rectY, rectW, rectH, rectR);
  scratchCtx.fill();

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

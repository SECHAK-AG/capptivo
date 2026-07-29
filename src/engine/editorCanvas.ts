import type { Rect } from "./types";
import {
  DEFAULT_FACE_CAM_MARGIN,
  FACE_CAM_COMPOSITION,
  FACE_CAM_MARGIN_MAX,
  FACE_CAM_MARGIN_MIN,
} from "./constants";
import {
  contentRectPixelsFromCrop,
  type ScreenContentCropNorm,
} from "./zoomMotion";
import { backgroundBlurPad, backgroundBlurScale } from "./backgroundBlurPad";
import { nativeCanvasBlurWorks } from "./canvasBlur";
import { gaussianBlurRgba } from "./gaussianBlur";
import { type ShadowPass } from "./shadowSprite";

export { backgroundBlurPad, backgroundBlurScale } from "./backgroundBlurPad";

/** Stage corner the face-cam PiP is tucked into. */
export type FaceCamCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export const DEFAULT_FACE_CAM_CORNER: FaceCamCorner = "bottom-right";

/** Clamp user margin; falls back to the auto stage-relative inset when omitted. */
export function resolveFaceCamMargin(
  width: number,
  height: number,
  marginPx?: number | null,
): number {
  if (typeof marginPx === "number" && Number.isFinite(marginPx)) {
    return Math.max(FACE_CAM_MARGIN_MIN, Math.min(FACE_CAM_MARGIN_MAX, marginPx));
  }
  const baseMargin = Math.max(
    FACE_CAM_COMPOSITION.minMargin,
    Math.min(width, height) * FACE_CAM_COMPOSITION.marginRatio,
  );
  const shadowInsetBudget =
    FACE_CAM_COMPOSITION.shadowBlur +
    Math.max(
      Math.abs(FACE_CAM_COMPOSITION.shadowOffsetX),
      Math.abs(FACE_CAM_COMPOSITION.shadowOffsetY),
    );
  return Math.max(6, baseMargin + shadowInsetBudget * 0.18);
}

/** Top-left of the PiP when tucked into `corner` with the given (or auto) margin. */
export function getFaceCamCornerPosition(
  width: number,
  height: number,
  camWidth: number,
  camHeight: number,
  corner: FaceCamCorner = DEFAULT_FACE_CAM_CORNER,
  marginPx: number = DEFAULT_FACE_CAM_MARGIN,
): { x: number; y: number } {
  const margin = resolveFaceCamMargin(width, height, marginPx);
  return {
    x:
      corner === "top-left" || corner === "bottom-left"
        ? margin
        : width - camWidth - margin,
    y:
      corner === "top-left" || corner === "top-right"
        ? margin
        : height - camHeight - margin,
  };
}

export type {
  ContentRectPixels,
  ScreenVideoCropOptions,
} from "./videoZoomCrop";
export { computeVideoZoomCrop } from "./videoZoomCrop";

export type FaceCamDrawOptions = {
  shadowIntensity: number;
  cornerRoundness?: number;
  widthPx?: number;
  heightPx?: number;
  forceCircle?: boolean;
  positionOverride?: { x: number; y: number } | null;
  corner?: FaceCamCorner;
  crop?: ScreenContentCropNorm | null;
  presenceScale?: number;
  /** Stage-edge inset in px (0–96). */
  marginPx?: number;
};

/** Layout + source crop for the face-cam PiP. */
export function resolveFaceCamLayout(
  videoWidth: number,
  videoHeight: number,
  width: number,
  height: number,
  options: FaceCamDrawOptions,
): {
  x: number;
  y: number;
  camWidth: number;
  camHeight: number;
  cornerRadius: number;
  corner: FaceCamCorner;
  presenceScale: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  shadow: {
    x: number;
    y: number;
    w: number;
    h: number;
    r: number;
    softSigma: number;
    softOpacity: number;
    tightSigma: number;
    tightOpacity: number;
    offsetX: number;
    offsetY: number;
  };
} | null {
  if (videoWidth <= 0 || videoHeight <= 0) return null;

  const intensityFactor = Math.max(0, options.shadowIntensity / 35);
  const baseSigma = FACE_CAM_COMPOSITION.shadowBlur / 2;
  const softSigma = Math.max(4, baseSigma * (0.7 + intensityFactor * 0.7));
  const softOpacity = Math.min(
    0.8,
    FACE_CAM_COMPOSITION.shadowOpacity * (0.35 + intensityFactor * 0.65),
  );
  const tightSigma = Math.max(2, baseSigma * (0.3 + intensityFactor * 0.35));
  const tightOpacity = Math.min(
    0.65,
    FACE_CAM_COMPOSITION.shadowOpacity * (0.25 + intensityFactor * 0.45),
  );

  const baseSize = Math.min(width, height) * FACE_CAM_COMPOSITION.widthRatio;
  const defaultWidth = baseSize;
  const defaultHeight = baseSize / FACE_CAM_COMPOSITION.aspectRatio;
  const widthPx: number = Number.isFinite(options.widthPx)
    ? (options.widthPx as number)
    : defaultWidth;
  const heightPx: number = Number.isFinite(options.heightPx)
    ? (options.heightPx as number)
    : defaultHeight;

  let camWidth: number;
  let camHeight: number;
  if (options.forceCircle) {
    const minRound = Math.max(
      FACE_CAM_COMPOSITION.minWidth,
      FACE_CAM_COMPOSITION.minHeight,
    );
    const maxRound = Math.min(
      FACE_CAM_COMPOSITION.maxWidth,
      FACE_CAM_COMPOSITION.maxHeight,
    );
    const size = Math.max(
      minRound,
      Math.min(maxRound, Math.max(widthPx, heightPx)),
    );
    camWidth = size;
    camHeight = size;
  } else {
    camWidth = Math.max(
      FACE_CAM_COMPOSITION.minWidth,
      Math.min(FACE_CAM_COMPOSITION.maxWidth, widthPx),
    );
    camHeight = Math.max(
      FACE_CAM_COMPOSITION.minHeight,
      Math.min(FACE_CAM_COMPOSITION.maxHeight, heightPx),
    );
  }

  const corner = options.corner ?? DEFAULT_FACE_CAM_CORNER;
  const cornerPosition = getFaceCamCornerPosition(
    width,
    height,
    camWidth,
    camHeight,
    corner,
    options.marginPx ?? DEFAULT_FACE_CAM_MARGIN,
  );
  const x =
    options.positionOverride != null
      ? options.positionOverride.x
      : cornerPosition.x;
  const y =
    options.positionOverride != null
      ? options.positionOverride.y
      : cornerPosition.y;
  const defaultCornerRadius =
    Math.min(camWidth, camHeight) * FACE_CAM_COMPOSITION.cornerRadiusRatio;
  const roundness = options.forceCircle
    ? Math.min(camWidth, camHeight) / 2
    : options.cornerRoundness != null &&
        Number.isFinite(options.cornerRoundness)
      ? options.cornerRoundness
      : defaultCornerRadius;
  const cornerRadius = Math.max(
    0,
    Math.min(Math.min(camWidth, camHeight) / 2, roundness),
  );

  const region = options.crop
    ? contentRectPixelsFromCrop(videoWidth, videoHeight, options.crop)
    : { ox: 0, oy: 0, rw: videoWidth, rh: videoHeight };
  const targetAspect = camWidth / camHeight;
  const sourceAspect = region.rw / region.rh;
  let sourceWidth = region.rw;
  let sourceHeight = region.rh;
  let sourceX = region.ox;
  let sourceY = region.oy;

  if (sourceAspect > targetAspect) {
    sourceWidth = region.rh * targetAspect;
    sourceX = region.ox + (region.rw - sourceWidth) / 2;
  } else {
    sourceHeight = region.rw / targetAspect;
    sourceY = region.oy + (region.rh - sourceHeight) / 2;
  }

  const inset = 1;
  const presenceScale = Number.isFinite(options.presenceScale)
    ? Math.min(1, Math.max(1e-6, options.presenceScale as number))
    : 1;

  return {
    x,
    y,
    camWidth,
    camHeight,
    cornerRadius,
    corner,
    presenceScale,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    shadow: {
      x: x + inset,
      y: y + inset,
      w: Math.max(1, camWidth - inset * 2),
      h: Math.max(1, camHeight - inset * 2),
      r: Math.max(0, cornerRadius - inset),
      softSigma,
      softOpacity,
      tightSigma,
      tightOpacity,
      offsetX: FACE_CAM_COMPOSITION.shadowOffsetX,
      offsetY: FACE_CAM_COMPOSITION.shadowOffsetY,
    },
  };
}

export type FaceCamShadowLayout = NonNullable<
  ReturnType<typeof resolveFaceCamLayout>
>["shadow"];

/** The PiP's shadow stack for the Pixi compositor. */
export function faceCamShadowPasses(
  shadow: FaceCamShadowLayout,
): readonly ShadowPass[] {
  return [
    {
      sigma: shadow.softSigma,
      opacity: shadow.softOpacity,
      offsetX: shadow.offsetX,
      offsetY: shadow.offsetY,
    },
    {
      sigma: shadow.tightSigma,
      opacity: shadow.tightOpacity,
      offsetX: shadow.offsetX,
      offsetY: Math.max(2, shadow.offsetY * 0.55),
    },
  ];
}

export function hitTestHandle(
  px: number,
  py: number,
  rect: Rect,
  handleSize: number,
): string | null {
  const { x, y, width, height } = rect;

  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return null;
  }

  if (width <= 0 || height <= 0) {
    return null;
  }

  const shortSide = Math.min(width, height);
  const cornerSlopPx = 10;
  const cornerR = Math.min(
    handleSize / 2 + cornerSlopPx,
    Math.max(8, shortSide * 0.48),
  );

  const inCorner = (cx: number, cy: number): boolean => {
    const dx = px - cx;
    const dy = py - cy;

    return dx * dx + dy * dy <= cornerR * cornerR;
  };

  const corners: [string, number, number][] = [
    ["nw", x, y],
    ["ne", x + width, y],
    ["sw", x, y + height],
    ["se", x + width, y + height],
  ];

  for (const [name, cx, cy] of corners) {
    if (inCorner(cx, cy)) {
      return name;
    }
  }

  const strip = Math.max(10, handleSize / 2 + 8);

  if (py >= y - strip && py <= y + strip && px >= x && px <= x + width) {
    return "n";
  }

  if (
    py >= y + height - strip &&
    py <= y + height + strip &&
    px >= x &&
    px <= x + width
  ) {
    return "s";
  }

  if (px >= x - strip && px <= x + strip && py >= y && py <= y + height) {
    return "w";
  }

  if (
    px >= x + width - strip &&
    px <= x + width + strip &&
    py >= y &&
    py <= y + height
  ) {
    return "e";
  }

  return null;
}

export function getCompositionLayout(
  sourceAspect: number,
  width: number,
  height: number,
  devicePadding: number,
): { device: Rect; video: Rect } {
  const safeAspect =
    Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : 16 / 9;

  const device: Rect = {
    x: devicePadding,
    y: devicePadding,
    width: width - devicePadding * 2,
    height: height - devicePadding * 2,
  };

  const deviceAspect = device.width / device.height;
  let videoWidth: number;
  let videoHeight: number;

  if (safeAspect > deviceAspect) {
    videoWidth = device.width;
    videoHeight = device.width / safeAspect;
  } else {
    videoHeight = device.height;
    videoWidth = device.height * safeAspect;
  }

  const video: Rect = {
    x: device.x + (device.width - videoWidth) / 2,
    y: device.y + (device.height - videoHeight) / 2,
    width: videoWidth,
    height: videoHeight,
  };

  return { device, video };
}

/**
 * Reduce device padding while zoomed (matches web editor `getZoomReactiveDevicePadding`).
 */
export const ZOOM_PADDING_REDUCTION_STRENGTH = 0.9;
export const ZOOM_PADDING_MIN_RATIO = 0.08;

export function getZoomReactiveDevicePadding(
  basePadding: number,
  zoomScale: number,
): number {
  const safeBasePadding = Math.max(0, Number(basePadding) || 0);
  const safeZoomScale = Math.max(1, Number(zoomScale) || 1);

  if (safeBasePadding <= 0 || safeZoomScale <= 1) {
    return safeBasePadding;
  }

  const effectiveZoomScale =
    1 + (safeZoomScale - 1) * ZOOM_PADDING_REDUCTION_STRENGTH;
  const reducedPadding = safeBasePadding / Math.max(1, effectiveZoomScale);
  const minPadding = safeBasePadding * ZOOM_PADDING_MIN_RATIO;

  return Math.max(minPadding, Math.min(safeBasePadding, reducedPadding));
}

/** Face-cam scale from the zoom envelope (synced with zoom motion). */
export function computeFaceCamZoomPresenceScale(
  zoomEnvelope: number,
  minScaleAtFullZoom: number,
): number {
  const env = Number.isFinite(zoomEnvelope)
    ? Math.min(1, Math.max(0, zoomEnvelope))
    : 0;

  if (env <= 1e-9) {
    return 1;
  }

  const minScale = Number.isFinite(minScaleAtFullZoom)
    ? Math.min(1, Math.max(1e-6, minScaleAtFullZoom))
    : 1;

  return 1 - (1 - minScale) * env;
}

// Cached blurred background — inputs change only on slider drag.
let bgCanvas: HTMLCanvasElement | null = null;
let bgPadCanvas: HTMLCanvasElement | null = null;
let bgBlurCanvas: HTMLCanvasElement | null = null;
let bgSig = {
  image: null as CanvasImageSource | null,
  width: -1,
  height: -1,
  blur: -1,
  darkness: -1,
};

function sourceSize(image: CanvasImageSource): { w: number; h: number } {
  if (image instanceof HTMLImageElement) {
    return { w: image.naturalWidth, h: image.naturalHeight };
  }
  if (image instanceof HTMLVideoElement) {
    return { w: image.videoWidth, h: image.videoHeight };
  }
  if (image instanceof HTMLCanvasElement || image instanceof OffscreenCanvas) {
    return { w: image.width, h: image.height };
  }
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    return { w: image.width, h: image.height };
  }
  return { w: 0, h: 0 };
}

/**
 * object-fit: cover dest rect — always covers tw×th (may extend past).
 * Pure so selfchecks can lock the framing without a DOM canvas.
 */
export function coverDestRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
): { x: number; y: number; width: number; height: number } {
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const tw = Math.max(1, destW);
  const th = Math.max(1, destH);
  const scale = Math.max(tw / sw, th / sh);
  const width = sw * scale;
  const height = sh * scale;
  return { x: (tw - width) / 2, y: (th - height) / 2, width, height };
}

/** Draw `image` covering `tw×th` at `(dx, dy)` — crops overflow, never letterboxes. */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  tw: number,
  th: number,
  dx = 0,
  dy = 0,
): void {
  const { w: iw, h: ih } = sourceSize(image);
  if (iw < 1 || ih < 1) return;
  const r = coverDestRect(iw, ih, tw, th);
  ctx.drawImage(image, dx + r.x, dy + r.y, r.width, r.height);
}

/** Extend the already-drawn inner rect into the blur pad so edges stay solid. */
function fillBlurPad(
  ctx: CanvasRenderingContext2D,
  pad: number,
  w: number,
  h: number,
): void {
  if (pad < 1 || w < 1 || h < 1) return;
  const c = ctx.canvas;

  ctx.drawImage(c, pad, pad, 1, h, 0, pad, pad, h);
  ctx.drawImage(c, pad + w - 1, pad, 1, h, pad + w, pad, pad, h);
  ctx.drawImage(c, pad, pad, w, 1, pad, 0, w, pad);
  ctx.drawImage(c, pad, pad + h - 1, w, 1, pad, pad + h, w, pad);

  ctx.drawImage(c, pad, pad, 1, 1, 0, 0, pad, pad);
  ctx.drawImage(c, pad + w - 1, pad, 1, 1, pad + w, 0, pad, pad);
  ctx.drawImage(c, pad, pad + h - 1, 1, 1, 0, pad + h, pad, pad);
  ctx.drawImage(c, pad + w - 1, pad + h - 1, 1, 1, pad + w, pad + h, pad, pad);
}

function ensureCanvas(
  current: HTMLCanvasElement | null,
  width: number,
  height: number,
): HTMLCanvasElement {
  const c = current ?? document.createElement("canvas");
  if (c.width !== width) c.width = width;
  if (c.height !== height) c.height = height;
  return c;
}

// ponytail: CPU blur capped harder than native — result is upscaled anyway.
const CPU_BLUR_MAX_DIM = 1024;

function renderBackgroundToCache(
  image: CanvasImageSource,
  width: number,
  height: number,
  safeBlur: number,
  darknessPercent: number,
): void {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  bgCanvas = ensureCanvas(bgCanvas, w, h);

  const ctx = bgCanvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = "none";

  if (safeBlur <= 0) {
    drawImageCover(ctx, image, w, h);
  } else {
    const nativeBlur = nativeCanvasBlurWorks();
    let scale = backgroundBlurScale(safeBlur);
    if (!nativeBlur) scale = Math.min(scale, CPU_BLUR_MAX_DIM / Math.max(w, h));
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));
    const sBlur = safeBlur * scale;
    const pad = backgroundBlurPad(sBlur);
    const pw = sw + pad * 2;
    const ph = sh + pad * 2;

    bgPadCanvas = ensureCanvas(bgPadCanvas, pw, ph);
    bgBlurCanvas = ensureCanvas(bgBlurCanvas, pw, ph);

    const pctx = bgPadCanvas.getContext(
      "2d",
      nativeBlur ? undefined : { willReadFrequently: true },
    );
    const bctx = bgBlurCanvas.getContext("2d");
    if (!pctx || !bctx) return;

    pctx.clearRect(0, 0, pw, ph);
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.filter = "none";
    drawImageCover(pctx, image, sw, sh, pad, pad);
    fillBlurPad(pctx, pad, sw, sh);

    if (nativeBlur) {
      bctx.clearRect(0, 0, pw, ph);
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = "high";
      bctx.filter = `blur(${sBlur}px)`;
      bctx.drawImage(bgPadCanvas, 0, 0);
      bctx.filter = "none";
    } else {
      const frame = pctx.getImageData(0, 0, pw, ph);
      gaussianBlurRgba(frame.data, pw, ph, sBlur);
      bctx.putImageData(frame, 0, 0);
    }

    ctx.drawImage(bgBlurCanvas, pad, pad, sw, sh, 0, 0, w, h);
  }

  if (darknessPercent > 0) {
    const opacity = Math.max(0, Math.min(1, darknessPercent / 100));
    ctx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
    ctx.fillRect(0, 0, w, h);
  }
}

export function drawBackgroundLayer(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  blurPx: number,
  darknessPercent: number,
  offsetX = 0,
  offsetY = 0,
): void {
  const safeBlur = Math.max(0, blurPx);

  if (
    bgSig.image !== image ||
    bgSig.width !== width ||
    bgSig.height !== height ||
    bgSig.blur !== safeBlur ||
    bgSig.darkness !== darknessPercent
  ) {
    renderBackgroundToCache(image, width, height, safeBlur, darknessPercent);
    bgSig = { image, width, height, blur: safeBlur, darkness: darknessPercent };
  }

  if (!bgCanvas) return;
  context.save();
  context.beginPath();
  context.rect(offsetX, offsetY, width, height);
  context.clip();
  context.drawImage(bgCanvas, offsetX, offsetY);
  context.restore();
}

export { formatTime } from "./utils";

export function getHandleCursor(handle?: string): string {
  if (!handle) return "default";
  if (handle === "n" || handle === "s") return "ns-resize";
  if (handle === "e" || handle === "w") return "ew-resize";
  if (handle === "nw" || handle === "se") return "nwse-resize";
  if (handle === "ne" || handle === "sw") return "nesw-resize";
  return "default";
}

/**
 * Cursor overlay for preview + export.
 * SVGs are rasterized once at high resolution — never drawn as tiny CSS-scaled
 * filtered SVGs (that is why they looked soft before).
 */

import type { CursorShapeId, ScreenContentCropNorm } from "./zoomMotion";
import {
  createFullNormToContentNdcFromCrop,
  sampleCursorAtTime,
  type RecordingMetadata,
} from "./zoomMotion.ts";
import type { TrimSegment } from "./trimSegments";
import {
  CURSOR_CLICK_EFFECT_IDS,
  type CursorClickEffectId,
} from "./cursorMotion.ts";

export const CURSOR_STYLE_IDS = [
  "macos",
  "tahoe",
  "tahoe-inverted",
  "figma",
] as const;

export type CursorStyleId = (typeof CURSOR_STYLE_IDS)[number];

export type CursorSettings = {
  showCursor: boolean;
  /** Glide the cursor back to its first-frame position near the end, so the video loops seamlessly. */
  loopCursor: boolean;
  /** Fade the cursor out while it sits still, back in as it starts moving. */
  hideStaticCursor: boolean;
  style: CursorStyleId;
  size: number;
  motionBlur: number;
  /** 0–1: spring chase strength (0 = raw recorded path). */
  smoothness: number;
  /** 0–0.4: click bounce squash intensity (0 = off). */
  clickShrink: number;
  /** 0–1: velocity-based lean into turns (0 = off). */
  sway: number;
  /** Opt-in click ring; default none so tip feel stays clean. */
  clickEffect: CursorClickEffectId;
};

/** Default cursor overlay settings. */
export const DEFAULT_CURSOR_SETTINGS: CursorSettings = {
  showCursor: true,
  loopCursor: true,
  hideStaticCursor: true,
  style: "tahoe",
  size: 3.0,
  motionBlur: 0.35,
  smoothness: 0.65,
  clickShrink: 0.2,
  sway: 0.25,
  clickEffect: "none",
};

/** Preview tile: 48px frame, ~28px glyph (macos scaled to match tahoe). */
export const CURSOR_PREVIEW_FRAME_PX = 48;
export const CURSOR_PREVIEW_GLYPH_PX = 28;

export type CursorAsset = {
  /** High-res raster (PNG) — used for overlay + crisp previews. */
  image: HTMLImageElement;
  previewUrl: string;
  anchorX: number;
  anchorY: number;
};

/**
 * Cursor theme packs. Each pack ships every replayable glyph under
 * `public/cursors/<theme>/`, and each glyph declares its hotspot as a
 * *fraction of its own SVG viewBox* — the pixel the OS treats as the click
 * point (arrow tip, I-beam center, fingertip). The hotspot is authored into
 * the asset set; `trimToContent` remaps it into the trimmed raster, so a
 * glyph redrawn with different padding cannot silently move its tip.
 *
 * Naming convention inside a pack: plain compass names (`resize-ew`) are the
 * window-edge resize style; `-alt` variants are the classic black-arrow
 * style. `scripts/check-cursor-hotspots.mjs` asserts every declared hotspot
 * still lands on its artwork.
 */
type CursorTheme = "macos" | "tahoe";

/** File each recorded shape replays with, identical across theme packs. */
const CURSOR_SHAPE_FILES: Record<CursorShapeId, string> = {
  default: "arrow.svg",
  pointer: "pointer.svg",
  text: "text.svg",
  grab: "open-hand.svg",
  grabbing: "closed-hand.svg",
  crosshair: "crosshair.svg",
  "resize-ew": "resize-ew.svg",
  "resize-ns": "resize-ns.svg",
  "resize-nesw": "resize-nesw.svg",
  "resize-nwse": "resize-nwse.svg",
  "not-allowed": "not-allowed.svg",
  alias: "alias.svg",
  copy: "copy.svg",
  "context-menu": "context-menu.svg",
};

/** Hotspots per theme, as fractions of each SVG's viewBox. */
const THEME_HOTSPOTS: Record<
  CursorTheme,
  Record<CursorShapeId, { x: number; y: number }>
> = {
  macos: {
    default: { x: 0.34, y: 0.24 },
    pointer: { x: 0.39, y: 0.26 },
    text: { x: 0.5, y: 0.5 },
    grab: { x: 0.5, y: 0.5 },
    grabbing: { x: 0.5, y: 0.5 },
    crosshair: { x: 0.5, y: 0.5 },
    "resize-ew": { x: 0.5, y: 0.5 },
    "resize-ns": { x: 0.5, y: 0.5 },
    "resize-nesw": { x: 0.5, y: 0.5 },
    "resize-nwse": { x: 0.5, y: 0.5 },
    "not-allowed": { x: 0.23, y: 0 },
    alias: { x: 0.63, y: 0.29 },
    copy: { x: 0.23, y: 0 },
    "context-menu": { x: 0.26, y: 0.21 },
  },
  tahoe: {
    default: { x: 0.14, y: 0.06 },
    pointer: { x: 0.4, y: 0.1 },
    text: { x: 0.5, y: 0.44 },
    grab: { x: 0.55, y: 0.57 },
    grabbing: { x: 0.5, y: 0.46 },
    crosshair: { x: 0.5, y: 0.5 },
    "resize-ew": { x: 0.5, y: 0.5 },
    "resize-ns": { x: 0.5, y: 0.49 },
    "resize-nesw": { x: 0.5, y: 0.46 },
    "resize-nwse": { x: 0.51, y: 0.46 },
    "not-allowed": { x: 0.23, y: 0 },
    alias: { x: 0.63, y: 0.29 },
    copy: { x: 0.23, y: 0 },
    "context-menu": { x: 0.12, y: 0.05 },
  },
};

/** The one style without a theme pack: a single minimal arrow glyph. */
const FIGMA_ARROW = { url: "/cursors/minimal.svg", x: 0.1, y: 0.05 };

/**
 * Which theme pack a picker style replays from. "figma" has no pack of its
 * own — its arrow is the minimal glyph and contextual shapes borrow tahoe.
 */
const STYLE_THEME: Record<CursorStyleId, { theme: CursorTheme; invert: boolean }> = {
  macos: { theme: "macos", invert: false },
  tahoe: { theme: "tahoe", invert: false },
  "tahoe-inverted": { theme: "tahoe", invert: true },
  figma: { theme: "tahoe", invert: false },
};

function shapeAssetSpec(
  style: CursorStyleId,
  shape: CursorShapeId,
): { url: string; x: number; y: number; invert: boolean } {
  if (style === "figma" && shape === "default") {
    return { ...FIGMA_ARROW, invert: false };
  }
  const { theme, invert } = STYLE_THEME[style];
  const hotspot = THEME_HOTSPOTS[theme][shape];
  return {
    url: `/cursors/${theme}/${CURSOR_SHAPE_FILES[shape]}`,
    x: hotspot.x,
    y: hotspot.y,
    invert,
  };
}

/** Raster height for overlay/export. */
const RASTER_HEIGHT = 256;

// Keyed by `${url}|${invert}` so styles sharing a pack share rasters.
const assetCache = new Map<string, Promise<CursorAsset | null>>();
const readyAssetCache = new Map<string, CursorAsset>();
const previewUrlCache = new Map<CursorStyleId, string>();

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function parseCursorSettings(raw: unknown): CursorSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CURSOR_SETTINGS };
  const o = raw as Record<string, unknown>;
  const style = CURSOR_STYLE_IDS.includes(o.style as CursorStyleId)
    ? (o.style as CursorStyleId)
    : DEFAULT_CURSOR_SETTINGS.style;
  const clickEffect = CURSOR_CLICK_EFFECT_IDS.includes(
    o.clickEffect as CursorClickEffectId,
  )
    ? (o.clickEffect as CursorClickEffectId)
    : DEFAULT_CURSOR_SETTINGS.clickEffect;
  return {
    showCursor: asBool(o.showCursor, DEFAULT_CURSOR_SETTINGS.showCursor),
    loopCursor: asBool(o.loopCursor, DEFAULT_CURSOR_SETTINGS.loopCursor),
    hideStaticCursor: asBool(
      o.hideStaticCursor,
      DEFAULT_CURSOR_SETTINGS.hideStaticCursor,
    ),
    style,
    size: clamp(asNum(o.size, DEFAULT_CURSOR_SETTINGS.size), 0.5, 4),
    motionBlur: clamp(
      asNum(o.motionBlur, DEFAULT_CURSOR_SETTINGS.motionBlur),
      0,
      1,
    ),
    smoothness: clamp(
      asNum(o.smoothness, DEFAULT_CURSOR_SETTINGS.smoothness),
      0,
      1,
    ),
    clickShrink: clamp(
      asNum(o.clickShrink, DEFAULT_CURSOR_SETTINGS.clickShrink),
      0,
      0.4,
    ),
    sway: clamp(asNum(o.sway, DEFAULT_CURSOR_SETTINGS.sway), 0, 1),
    clickEffect,
  };
}

export function cursorPreviewGlyphPx(_style: CursorStyleId): number {
  // Rasters are content-trimmed, so every style previews at the same glyph box.
  return CURSOR_PREVIEW_GLYPH_PX;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`failed to load cursor asset: ${url}`));
    img.src = url;
  });
}

function canvasToImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("cursor raster encode failed"));
    image.src = canvas.toDataURL("image/png");
  });
}

/**
 * Crop a rasterized cursor to its visible pixels and remap the hotspot into
 * the cropped space. Cursor SVGs are authored on wildly different canvases —
 * tight-cropped arrows (618×958 tahoe) vs 32px design grids where the glyph
 * fills half the box (hands/text) — so normalizing every asset to its own
 * content bounding box is what lets ONE sizing rule (`baseH`) draw all of
 * them at the same visual size, with no per-style fudge multipliers.
 */
function trimToContent(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  anchorX: number,
  anchorY: number,
): { canvas: HTMLCanvasElement; anchorX: number; anchorY: number } {
  const { width, height } = canvas;
  const px = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (px[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { canvas, anchorX, anchorY }; // fully transparent — keep as-is

  const pad = 1;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  // 1:1 sub-rect copy — no resample, so the raster stays as sharp as drawn.
  out.getContext("2d")!.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  return {
    canvas: out,
    anchorX: clamp((anchorX * width - minX) / w, 0, 1),
    anchorY: clamp((anchorY * height - minY) / h, 0, 1),
  };
}

/**
 * Draw SVG (or any image) into a fixed-height bitmap. Forces a sharp raster for
 * WebKit/Chrome — CSS-scaling huge filtered SVGs looks muddy.
 */
async function rasterizeToAsset(
  source: CanvasImageSource & {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  },
  anchorX: number,
  anchorY: number,
  invert = false,
): Promise<CursorAsset> {
  const srcW = Math.max(1, source.naturalWidth || source.width || 1);
  const srcH = Math.max(1, source.naturalHeight || source.height || 1);
  const height = RASTER_HEIGHT;
  const width = Math.max(1, Math.round((srcW / srcH) * height));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);

  if (invert) {
    const data = ctx.getImageData(0, 0, width, height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      px[i] = 255 - px[i];
      px[i + 1] = 255 - px[i + 1];
      px[i + 2] = 255 - px[i + 2];
    }
    ctx.putImageData(data, 0, 0);
  }

  const trimmed = trimToContent(canvas, ctx, anchorX, anchorY);
  const previewUrl = trimmed.canvas.toDataURL("image/png");
  const image = await canvasToImage(trimmed.canvas);
  return {
    image,
    previewUrl,
    anchorX: trimmed.anchorX,
    anchorY: trimmed.anchorY,
  };
}

async function loadSvgAsImage(url: string): Promise<HTMLImageElement> {
  // Explicit dimensions help WKWebView pick a crisp SVG raster size.
  const img = await loadImage(url);
  if (img.naturalWidth > 0 && img.naturalHeight > 0) return img;
  return img;
}

/** Load + rasterize one glyph, cached across styles that share a pack. */
function loadShapeAsset(
  style: CursorStyleId,
  shape: CursorShapeId,
): Promise<CursorAsset | null> {
  const spec = shapeAssetSpec(style, shape);
  const key = `${spec.url}|${spec.invert ? 1 : 0}`;
  const cached = assetCache.get(key);
  if (cached) return cached;
  const promise = loadSvgAsImage(spec.url)
    .then((svg) => rasterizeToAsset(svg, spec.x, spec.y, spec.invert))
    .then((asset) => {
      readyAssetCache.set(key, asset);
      if (shape === "default") previewUrlCache.set(style, asset.previewUrl);
      return asset;
    })
    .catch(() => null);
  assetCache.set(key, promise);
  return promise;
}

/**
 * Contextual cursor for a recorded shape, in the picked style's own theme —
 * the recorded system state (pointing hand over links, I-beam over text,
 * resize arrows at edges…) overrides the arrow for as long as it lasts.
 * Synchronous: returns null (and starts the load) until rasterized.
 */
function ensureShapeAsset(
  style: CursorStyleId,
  shape: CursorShapeId,
): CursorAsset | null {
  const spec = shapeAssetSpec(style, shape);
  const hit = readyAssetCache.get(`${spec.url}|${spec.invert ? 1 : 0}`);
  if (hit) return hit;
  void loadShapeAsset(style, shape);
  return null;
}

export function preloadCursorAssets(): void {
  // Arrows first — the style picker previews need them immediately.
  for (const style of CURSOR_STYLE_IDS) {
    void loadShapeAsset(style, "default");
  }
  for (const style of CURSOR_STYLE_IDS) {
    for (const shape of Object.keys(CURSOR_SHAPE_FILES) as CursorShapeId[]) {
      if (shape !== "default") void loadShapeAsset(style, shape);
    }
  }
}

/**
 * Click press effect — the cursor eases slightly smaller on mouse-down, STAYS
 * pressed for as long as the button is held (so drags/grabs read as held), and
 * springs back on release. Driven by the recorded down→up intervals, so it is
 * a pure function of (track, time): scrubbing and export render identically.
 */
const PRESS_IN_S = 0.09;
const PRESS_OUT_S = 0.18;
/**
 * Every recorded click holds the pressed pose at least this long. A ~10 ms
 * trackpad tap otherwise barely starts the press-in curve while the release
 * curve assumes full depth was reached — which rendered as a pop instead of a
 * bounce. Holding through the full press-in also makes the two curves meet
 * continuously.
 */
const PRESS_MIN_HOLD_S = PRESS_IN_S;

function cursorPressScale(
  intervals: readonly { start: number; end: number }[] | undefined,
  time: number,
  shrink: number,
): number {
  if (shrink <= 0.001 || !intervals || intervals.length === 0) return 1;

  // Last interval starting at or before `time` — the only one that can affect
  // it (either still held, or in its release tail).
  let lo = 0;
  let hi = intervals.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (intervals[mid].start <= time) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return 1;

  const press = intervals[idx];
  const end = Math.max(press.end, press.start + PRESS_MIN_HOLD_S);
  if (time <= end) {
    // Pressing in: quick ease down, then hold at the pressed size.
    return 1 - shrink * smoothstep01((time - press.start) / PRESS_IN_S);
  }
  // Released: spring back up over a slightly longer, softer ease.
  return 1 - shrink * (1 - smoothstep01((time - end) / PRESS_OUT_S));
}

/** Instant swaps between cursor shapes read as glitches — blend briefly instead. */
const SHAPE_CROSSFADE_S = 0.14;

/**
 * Recorded shape at `time` plus the transition it is in, for a short
 * crossfade on shape changes. Pure function of the track — preview and
 * export render identical frames. `progress` is 1 once settled.
 */
function sampleCursorShapeTransition(
  metadata: RecordingMetadata,
  time: number,
): { shape: CursorShapeId; prevShape: CursorShapeId; progress: number } {
  const samples = metadata.cursorSamples;
  if (samples.length === 0 || time <= samples[0].t) {
    const first = samples[0]?.shape ?? "default";
    return { shape: first, prevShape: first, progress: 1 };
  }

  // Binary search: last sample at or before `time`.
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  const shape = samples[lo].shape ?? "default";

  // Find where this shape's run began — but only within the crossfade window,
  // so the backward scan is bounded (~9 samples at 60 Hz), not O(run length).
  const windowStart = time - SHAPE_CROSSFADE_S;
  let runStart = lo;
  while (
    runStart > 0 &&
    samples[runStart - 1].t > windowStart &&
    (samples[runStart - 1].shape ?? "default") === shape
  ) {
    runStart -= 1;
  }

  if (runStart > 0) {
    const changedAt = samples[runStart].t;
    const prevShape = samples[runStart - 1].shape ?? "default";
    if (prevShape !== shape && changedAt > windowStart) {
      // A fade must COMPLETE by the end of the track: recordings typically end
      // on a shape change (hovering/clicking the stop button), and a fade that
      // outlives the last sample would freeze the final frame as a permanent
      // two-cursor blend. Shorten the fade to whatever track time remains.
      const trackEnd = samples[samples.length - 1].t;
      const fadeSpan = Math.min(SHAPE_CROSSFADE_S, trackEnd - changedAt);
      if (fadeSpan > 1e-3) {
        return {
          shape,
          prevShape,
          progress: clamp((time - changedAt) / fadeSpan, 0, 1),
        };
      }
    }
  }
  return { shape, prevShape: shape, progress: 1 };
}

/** The style's arrow glyph; null (load started) until rasterized. */
export function ensureCursorAsset(style: CursorStyleId): CursorAsset | null {
  return ensureShapeAsset(style, "default");
}

/** Resolves when the style's arrow is rasterized to a crisp PNG. */
export function loadCursorAsset(
  style: CursorStyleId,
): Promise<CursorAsset | null> {
  return loadShapeAsset(style, "default");
}

/** Crisp PNG data-URL once rasterized; falls back to the raw SVG until ready. */
export function cursorStylePreviewUrl(style: CursorStyleId): string | null {
  const cached = previewUrlCache.get(style);
  if (cached) return cached;
  void ensureCursorAsset(style);
  return shapeAssetSpec(style, "default").url;
}

/**
 * Loop cursor position — for seamlessly loopable videos (social/demo clips):
 * over the last {@link CURSOR_LOOP_RETURN_S} of the *final* video the cursor
 * glides from its recorded position back to where it sits on the first frame,
 * so frame N loops into frame 0 without a pointer jump.
 */
export const CURSOR_LOOP_RETURN_S = 0.75;

export type CursorLoopReturn = {
  /** Source time whose cursor position is the glide target (first kept frame). */
  targetTime: number;
  /** Source-time window (inside the last kept segment) where the glide runs. */
  windowStart: number;
  windowEnd: number;
};

/**
 * Derive the glide window from the trim segments so it lands at the end of the
 * final video, not the end of the raw recording. Returns null when there is
 * nothing meaningful to return across (e.g. sub-frame final segment).
 */
export function computeCursorLoopReturn(
  segments: readonly TrimSegment[],
  fallbackDuration: number,
): CursorLoopReturn | null {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const targetTime = first?.start ?? 0;
  const end = last?.end ?? fallbackDuration;
  const lastStart = last?.start ?? 0;
  if (!Number.isFinite(end) || end <= targetTime) return null;

  // Keep the window inside the last kept segment — a glide spanning a trim gap
  // would visibly jump when playback skips the gap.
  const window = Math.min(CURSOR_LOOP_RETURN_S, end - lastStart);
  if (window <= 1e-3) return null;
  return { targetTime, windowStart: end - window, windowEnd: end };
}

/** Eased 0→1 glide progress at source time `t` (0 before the window). */
function loopReturnBlend(loopReturn: CursorLoopReturn, t: number): number {
  if (t <= loopReturn.windowStart) return 0;
  const span = Math.max(1e-6, loopReturn.windowEnd - loopReturn.windowStart);
  return smoothstep01(
    (Math.min(t, loopReturn.windowEnd) - loopReturn.windowStart) / span,
  );
}

/**
 * Smooth cursor movement — shaky/rapid recorded motion becomes a glide.
 *
 * The recorded track is resampled onto a uniform 60 Hz grid once, then blurred
 * with a *centered* Gaussian. A symmetric kernel is zero-phase: the smoothed
 * cursor never lags behind the real one (a causal low-pass would trail it —
 * exactly the "not following my movements" feel). Because the whole track is
 * known ahead of time, offline smoothing like this is strictly better than
 * anything a live tool can do.
 *
 * The result is cached per (track, strength) and sampled O(1) per frame.
 */
const SMOOTH_RESAMPLE_HZ = 60;
/** Kernel σ at full strength, in seconds. ~3σ of support ≈ 0.4s of motion. */
const SMOOTH_MAX_SIGMA_S = 0.13;
/**
 * Hard bound on how far smoothing may move the glyph off the recorded sample,
 * in full-screen normalized units (≈4px on a 1745px-wide recording).
 *
 * A symmetric Gaussian adds no lag, but it *cuts corners*: it averages in where
 * the cursor was coming from, so it undershoots wherever the track bends. The
 * sharpest bend in any track is arriving at a button and stopping — i.e. every
 * click. Unbounded, σ=0.065s undershoots a normal click by ~23px at 1×, and the
 * camera multiplies that by the zoom scale, so a zoomed click lands visibly
 * outside the thing being clicked.
 *
 * Tremor — the jitter smoothing exists to remove — is well under this bound, so
 * clamping costs nothing where smoothing earns its keep and guarantees the
 * cursor points at the pixel it recorded everywhere else.
 */
const MAX_SMOOTH_DEVIATION = 0.0025;

type SmoothedCursorTrack = {
  t0: number;
  dt: number;
  xs: Float32Array;
  ys: Float32Array;
};

const smoothedTrackCache = new WeakMap<
  RecordingMetadata,
  { strength: number; track: SmoothedCursorTrack | null }
>();

function buildSmoothedTrack(
  metadata: RecordingMetadata,
  strength: number,
): SmoothedCursorTrack | null {
  const samples = metadata.cursorSamples;
  if (samples.length < 2) return null;
  const t0 = samples[0].t;
  const span = samples[samples.length - 1].t - t0;
  if (span <= 1e-3) return null;

  const dt = 1 / SMOOTH_RESAMPLE_HZ;
  const n = Math.ceil(span / dt) + 1;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);

  // Uniform resample via a single forward walk (samples are time-sorted).
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const t = t0 + i * dt;
    while (j < samples.length - 2 && samples[j + 1].t <= t) j += 1;
    const a = samples[j];
    const b = samples[Math.min(j + 1, samples.length - 1)];
    const seg = Math.max(1e-6, b.t - a.t);
    const p = Math.min(1, Math.max(0, (t - a.t) / seg));
    xs[i] = a.x + (b.x - a.x) * p;
    ys[i] = a.y + (b.y - a.y) * p;
  }

  const sigma = strength * SMOOTH_MAX_SIGMA_S * SMOOTH_RESAMPLE_HZ; // in samples
  const radius = Math.max(1, Math.round(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k += 1) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = w;
    sum += w;
  }
  for (let k = 0; k < kernel.length; k += 1) kernel[k] /= sum;

  // Edge handling: clamp-to-edge, so the endpoints stay anchored in place.
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let ax = 0;
    let ay = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const idx = Math.min(n - 1, Math.max(0, i + k));
      const w = kernel[k + radius];
      ax += xs[idx] * w;
      ay += ys[idx] * w;
    }
    sx[i] = ax;
    sy[i] = ay;
  }

  return { t0, dt, xs: sx, ys: sy };
}

/**
 * Smoothed position at `time`; falls back to the raw track at low strength.
 * Never further than {@link MAX_SMOOTH_DEVIATION} from the recorded sample —
 * exported so `cursorOverlay.selfcheck` can hold that bound.
 */
export function sampleSmoothedCursorAtTime(
  metadata: RecordingMetadata,
  time: number,
  strength: number,
): { x: number; y: number } | null {
  if (strength <= 0.02) return sampleCursorAtTime(metadata, time);

  let entry = smoothedTrackCache.get(metadata);
  if (!entry || Math.abs(entry.strength - strength) > 1e-3) {
    entry = { strength, track: buildSmoothedTrack(metadata, strength) };
    smoothedTrackCache.set(metadata, entry);
  }
  const track = entry.track;
  if (!track) return sampleCursorAtTime(metadata, time);

  const raw = sampleCursorAtTime(metadata, time);

  const f = (time - track.t0) / track.dt;
  const i = Math.floor(f);
  const last = track.xs.length - 1;
  let smoothed: { x: number; y: number };
  if (i < 0) smoothed = { x: track.xs[0], y: track.ys[0] };
  else if (i >= last) smoothed = { x: track.xs[last], y: track.ys[last] };
  else {
    const p = f - i;
    smoothed = {
      x: track.xs[i] + (track.xs[i + 1] - track.xs[i]) * p,
      y: track.ys[i] + (track.ys[i + 1] - track.ys[i]) * p,
    };
  }

  return raw ? clampToRawSample(smoothed, raw) : smoothed;
}

/**
 * Pull `smoothed` back onto the disc of radius {@link MAX_SMOOTH_DEVIATION}
 * around the recorded sample. Radial (not per-axis) so the correction never
 * changes the direction of the offset — a clamped glyph still sits on the line
 * between where smoothing put it and the pixel it points at.
 */
function clampToRawSample(
  smoothed: { x: number; y: number },
  raw: { x: number; y: number },
): { x: number; y: number } {
  const dx = smoothed.x - raw.x;
  const dy = smoothed.y - raw.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= MAX_SMOOTH_DEVIATION) return smoothed;
  const k = MAX_SMOOTH_DEVIATION / dist;
  return { x: raw.x + dx * k, y: raw.y + dy * k };
}

function mapCursorToContentNdc(
  metadata: RecordingMetadata,
  time: number,
  crop: ScreenContentCropNorm | null | undefined,
  _smoothness = 0,
): { x: number; y: number } | null {
  // Spring chase (PixiCursorOverlay) owns feel; this path stays raw so clicks
  // and seeks can snap to the recorded tip without Gaussian corner-cutting.
  const p = sampleCursorAtTime(metadata, time);
  if (!p) return null;
  if (!crop) return { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
  return createFullNormToContentNdcFromCrop(crop)(p);
}

function swayOffset(
  time: number,
  sway: number,
): { dx: number; dy: number; rot: number } {
  if (sway <= 0) return { dx: 0, dy: 0, rot: 0 };
  const amp = sway * 0.01;
  return {
    dx: Math.sin(time * 4.2) * amp,
    dy: Math.cos(time * 3.1) * amp,
    rot: Math.sin(time * 5.5) * sway * 0.08,
  };
}

/**
 * Auto-hide for the static cursor. The full track is known ahead of time, so
 * unlike live tools the fade-in can *anticipate* movement: the cursor is fully
 * visible again the moment it starts moving, never popping in mid-motion.
 */
const IDLE_DELAY_S = 1.5; // stillness tolerated before the fade-out starts
const IDLE_FADE_OUT_S = 0.5;
const IDLE_FADE_IN_S = 0.35;
/** Movement below this (normalized screen units) from the rest point is jitter. */
const IDLE_MOVE_EPSILON = 0.004;
/** Skip windows that would blink: require some fully-hidden time to bother. */
const IDLE_MIN_HIDDEN_S = 0.4;

/** `fadeOutStart` → invisible → visible again exactly at `fadeInEnd`. */
type CursorHideWindow = { fadeOutStart: number; fadeInEnd: number };

// Keyed by metadata identity; recomputed only when a new track loads.
const hideWindowsCache = new WeakMap<RecordingMetadata, CursorHideWindow[]>();

function computeCursorHideWindows(
  metadata: RecordingMetadata,
): CursorHideWindow[] {
  const samples = metadata.cursorSamples;
  if (samples.length === 0) return [];
  const clicks = metadata.cursorClickSamples ?? [];
  const windows: CursorHideWindow[] = [];

  const minIdleSpan =
    IDLE_DELAY_S + IDLE_FADE_OUT_S + IDLE_MIN_HIDDEN_S + IDLE_FADE_IN_S;
  const pushIdleGap = (idleStart: number, idleEnd: number) => {
    if (idleEnd - idleStart >= minIdleSpan) {
      windows.push({
        fadeOutStart: idleStart + IDLE_DELAY_S,
        fadeInEnd: idleEnd,
      });
    }
  };

  // Activity = drifting further than epsilon from the current rest point, or a
  // click (a click means the cursor matters right there, even if stationary).
  let anchorX = samples[0].x;
  let anchorY = samples[0].y;
  let lastActivity = samples[0].t;
  let clickIdx = 0;

  for (const sample of samples) {
    while (clickIdx < clicks.length && clicks[clickIdx].t <= sample.t) {
      const click = clicks[clickIdx];
      pushIdleGap(lastActivity, click.t);
      lastActivity = click.t;
      anchorX = click.x;
      anchorY = click.y;
      clickIdx += 1;
    }
    const dx = sample.x - anchorX;
    const dy = sample.y - anchorY;
    if (dx * dx + dy * dy > IDLE_MOVE_EPSILON * IDLE_MOVE_EPSILON) {
      pushIdleGap(lastActivity, sample.t);
      lastActivity = sample.t;
      anchorX = sample.x;
      anchorY = sample.y;
    }
  }

  // Still at the end of the track → hide and stay hidden.
  const trackEnd = samples[samples.length - 1].t;
  if (trackEnd - lastActivity >= IDLE_DELAY_S + IDLE_FADE_OUT_S) {
    windows.push({
      fadeOutStart: lastActivity + IDLE_DELAY_S,
      fadeInEnd: Number.POSITIVE_INFINITY,
    });
  }

  return windows;
}

function smoothstep01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Opacity multiplier at `time` (1 = fully shown), from the cached windows. */
function cursorIdleOpacity(metadata: RecordingMetadata, time: number): number {
  let windows = hideWindowsCache.get(metadata);
  if (!windows) {
    windows = computeCursorHideWindows(metadata);
    hideWindowsCache.set(metadata, windows);
  }
  if (windows.length === 0) return 1;

  // Binary search: last window whose fade-out has begun at `time`.
  let lo = 0;
  let hi = windows.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (windows[mid].fadeOutStart <= time) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return 1;

  const w = windows[idx];
  if (time >= w.fadeInEnd) return 1;
  const fadeOut = 1 - smoothstep01((time - w.fadeOutStart) / IDLE_FADE_OUT_S);
  const fadeIn = smoothstep01(1 - (w.fadeInEnd - time) / IDLE_FADE_IN_S);
  return Math.max(fadeOut, fadeIn);
}

export type CursorOverlayDrawInput = {
  time: number;
  settings: CursorSettings;
  metadata: RecordingMetadata | null;
  videoRect: { x: number; y: number; width: number; height: number };
  screenContentCrop?: ScreenContentCropNorm | null;
  /** Glide-back-to-start window (see {@link computeCursorLoopReturn}); null = off. */
  loopReturn?: CursorLoopReturn | null;
};

/**
 * A resolved cursor overlay for one frame: where it lands on the stage, and how
 * to paint it.
 *
 * The GPU compositor uses `bounds` to paint the cursor into a small canvas
 * (a few hundred pixels square) instead of a stage-sized one — the overlay is
 * the only layer whose pixels genuinely change every frame, so the size of that
 * per-frame texture upload is a first-order cost at 60 fps.
 */
export type CursorOverlayFrame = {
  /** Stage-space AABB covering every glyph this frame paints, in CSS pixels. */
  bounds: { x: number; y: number; width: number; height: number };
  /**
   * Identifies the *pixels* inside `bounds`, independent of where the AABB sits
   * on the stage. Pure translation of the whole cluster keeps this key stable so
   * the GPU layer can move the sprite without repainting.
   */
  contentKey: string;
  /** Paint into `ctx`, whose origin is the stage origin (translate first). */
  draw: (ctx: CanvasRenderingContext2D) => void;
  /**
   * Tip placements in unzoomed recording-rect space. Prefer this over `draw`
   * when the compositor can parent Pixi sprites under the camera — that path
   * cannot double-apply zoom the way a supersampled canvas layer can.
   */
  placement: CursorPlacementFrame;
};

/**
 * Cursor tip placements in *unzoomed* recording-rect space — the same space the
 * camera zooms. The compositor parents sprites under the camera and sets each
 * stamp's position to `x,y`; zoom is never multiplied in here.
 */
export type CursorPlacementFrame = {
  height: number;
  stamps: Array<{
    x: number;
    y: number;
    alpha: number;
    rotate: number;
    pressScale: number;
    asset: CursorAsset;
  }>;
};

/**
 * Dev-only crosshair at the *raw* recorded sample — no smoothing, no glyph, no
 * hotspot. It is the ground truth the glyph is supposed to sit on, drawn through
 * the identical camera transform, so one paused frame separates the two failure
 * modes that look identical on screen:
 *
 * - crosshair on the target, glyph off it  → glyph-side (hotspot / smoothing)
 * - crosshair off the target               → position-side (mapping / capture)
 *
 * Toggle from devtools: `__cursorDebug(true)`. Off in production builds.
 */
let cursorDebugOverlay = false;

export function setCursorDebugOverlay(enabled: boolean): void {
  cursorDebugOverlay = enabled;
}

/** Half-length of each crosshair arm, in composition pixels. */
const DEBUG_CROSSHAIR_ARM_PX = 26;

function drawDebugCrosshair(
  ctx: CanvasRenderingContext2D,
  at: { x: number; y: number },
): void {
  const arm = DEBUG_CROSSHAIR_ARM_PX;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2;
  // Magenta on a white halo so it reads over any recording content.
  for (const [color, width] of [
    ["rgba(255,255,255,0.9)", 4],
    ["rgba(255,0,220,1)", 2],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(at.x - arm, at.y);
    ctx.lineTo(at.x + arm, at.y);
    ctx.moveTo(at.x, at.y - arm);
    ctx.lineTo(at.x, at.y + arm);
    ctx.stroke();
  }
  ctx.restore();
}

export function resolveCursorOverlay(
  input: CursorOverlayDrawInput,
): CursorOverlayFrame | null {
  const { settings, metadata, videoRect } = input;
  if (
    !settings.showCursor ||
    !metadata ||
    metadata.cursorSamples.length === 0
  ) {
    return null;
  }

  const asset = ensureCursorAsset(settings.style);
  if (!asset) return null;

  const trackTime = input.time;
  const crop = input.screenContentCrop ?? null;
  const loopReturn = input.loopReturn ?? null;
  const loopTarget = loopReturn
    ? mapCursorToContentNdc(
        metadata,
        loopReturn.targetTime,
        crop,
        settings.smoothness,
      )
    : null;

  /** Recorded position at `t`, blended toward the first frame's position inside
   *  the loop-return window so the last frame matches the first exactly. */
  const resolvePos = (t: number): { x: number; y: number } | null => {
    const p = mapCursorToContentNdc(metadata, t, crop, settings.smoothness);
    if (!p || !loopReturn || !loopTarget) return p;
    const blend = loopReturnBlend(loopReturn, t);
    if (blend <= 0) return p;
    return {
      x: p.x + (loopTarget.x - p.x) * blend,
      y: p.y + (loopTarget.y - p.y) * blend,
    };
  };

  let idleOpacity = settings.hideStaticCursor
    ? cursorIdleOpacity(metadata, trackTime)
    : 1;
  if (settings.hideStaticCursor && loopReturn) {
    // A seamless loop needs matching *visibility* too: blend toward the
    // opacity the cursor has on the first frame so it can't pop on wrap.
    const blend = loopReturnBlend(loopReturn, trackTime);
    if (blend > 0) {
      const targetOpacity = cursorIdleOpacity(metadata, loopReturn.targetTime);
      idleOpacity = idleOpacity + (targetOpacity - idleOpacity) * blend;
    }
  }
  if (idleOpacity <= 0.001) return null; // fully faded — skip all draw work

  const base = resolvePos(trackTime);
  if (!base) return null;

  const sway = swayOffset(input.time, settings.sway);
  const headNdc = {
    x: clamp(base.x + sway.dx, 0, 1),
    y: clamp(base.y + sway.dy, 0, 1),
  };

  // Recorded system state overrides the picked arrow style while it lasts
  // (pointing hand, I-beam, resize arrows, grab…), drawn from the same theme
  // pack as the picked style. Falls back to the arrow until the contextual
  // glyph is rasterized. Shape changes crossfade briefly.
  const transition = sampleCursorShapeTransition(metadata, trackTime);
  const assetForShape = (s: CursorShapeId): CursorAsset =>
    (s !== "default" ? ensureShapeAsset(settings.style, s) : null) ?? asset;
  const activeAsset = assetForShape(transition.shape);
  const fadeIn = smoothstep01(transition.progress);
  const prevAsset =
    fadeIn < 1 && transition.prevShape !== transition.shape
      ? assetForShape(transition.prevShape)
      : null;

  const viewportScale = Math.max(
    0.55,
    Math.min(videoRect.width, videoRect.height) / 1080,
  );
  // Rasters are content-trimmed, so one height rule sizes every cursor equally.
  const baseH = 28 * viewportScale * settings.size;

  const pressScale = cursorPressScale(
    metadata.cursorPressIntervals,
    trackTime,
    settings.clickShrink,
  );

  const trailSteps = settings.motionBlur > 0.05 ? 3 : 0;
  const dt = 0.018 * settings.motionBlur;

  /** One glyph placement: hotspot on the stage + which asset(s) go there. */
  type Stamp = { x: number; y: number; alpha: number; rotate: number };
  const stamps: Stamp[] = [];
  for (let i = trailSteps; i >= 0; i -= 1) {
    const isHead = i === 0;
    const trailPos = isHead ? headNdc : resolvePos(trackTime - i * dt);
    if (!trailPos) continue;
    stamps.push({
      x: videoRect.x + trailPos.x * videoRect.width,
      y: videoRect.y + trailPos.y * videoRect.height,
      alpha:
        (isHead
          ? 0.95
          : 0.2 * settings.motionBlur * (1 - i / (trailSteps + 1))) *
        idleOpacity,
      rotate: isHead ? sway.rot : 0,
    });
  }
  if (stamps.length === 0) return null;

  // Pixi path: one sprite per trail stamp (+ optional crossfade of the head).
  const placementStamps: CursorPlacementFrame["stamps"] = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const s = stamps[i]!;
    const isHead = i === stamps.length - 1;
    if (isHead && prevAsset) {
      placementStamps.push({
        x: s.x,
        y: s.y,
        alpha: s.alpha * (1 - fadeIn),
        rotate: s.rotate,
        pressScale: 1,
        asset: prevAsset,
      });
      placementStamps.push({
        x: s.x,
        y: s.y,
        alpha: s.alpha * fadeIn,
        rotate: s.rotate,
        pressScale: 1,
        asset: activeAsset,
      });
    } else {
      placementStamps.push({
        x: s.x,
        y: s.y,
        alpha: s.alpha,
        rotate: s.rotate,
        pressScale: 1,
        asset: activeAsset,
      });
    }
  }

  const glyphSize = (a: CursorAsset) => {
    const aspect =
      a.image.naturalHeight > 0
        ? a.image.naturalWidth / a.image.naturalHeight
        : 1;
    return { w: baseH * aspect, h: baseH };
  };

  // Conservative AABB: every glyph is drawn around its hotspot, so a radius of
  // hypot(w, h) covers it under any sway rotation (press only shrinks).
  const glyphs = prevAsset ? [activeAsset, prevAsset] : [activeAsset];
  const radius =
    Math.max(...glyphs.map((a) => Math.hypot(glyphSize(a).w, glyphSize(a).h))) +
    2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of stamps) {
    minX = Math.min(minX, s.x - radius);
    minY = Math.min(minY, s.y - radius);
    maxX = Math.max(maxX, s.x + radius);
    maxY = Math.max(maxY, s.y + radius);
  }

  // Ground truth for the debug crosshair: the recorded sample, unsmoothed and
  // unclamped, mapped through the same content→rect transform as the glyph.
  const rawNdc = cursorDebugOverlay
    ? mapCursorToContentNdc(metadata, trackTime, crop, 0)
    : null;
  const rawPoint = rawNdc
    ? {
        x: videoRect.x + rawNdc.x * videoRect.width,
        y: videoRect.y + rawNdc.y * videoRect.height,
      }
    : null;
  if (rawPoint) {
    const arm = DEBUG_CROSSHAIR_ARM_PX + 2;
    minX = Math.min(minX, rawPoint.x - arm);
    minY = Math.min(minY, rawPoint.y - arm);
    maxX = Math.max(maxX, rawPoint.x + arm);
    maxY = Math.max(maxY, rawPoint.y + arm);
  }

  const draw = (ctx: CanvasRenderingContext2D) => {
    const drawGlyph = (a: CursorAsset, alpha: number) => {
      const { w, h } = glyphSize(a);
      ctx.globalAlpha = alpha;
      ctx.drawImage(a.image, -w * a.anchorX, -h * a.anchorY, w, h);
    };

    // `stamps` is ordered oldest trail → current, matching the paint order.
    for (let i = 0; i < stamps.length; i += 1) {
      const s = stamps[i]!;
      const isHead = i === stamps.length - 1;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rotate);
      // Press shrinks around the hotspot, so the cursor squeezes into the
      // exact point being clicked instead of drifting off it.
      if (pressScale !== 1) ctx.scale(pressScale, pressScale);
      if (isHead && prevAsset) {
        // Mid shape-change: blend old → new glyph (trail keeps the new one).
        drawGlyph(prevAsset, s.alpha * (1 - fadeIn));
        drawGlyph(activeAsset, s.alpha * fadeIn);
      } else {
        drawGlyph(activeAsset, s.alpha);
      }
      ctx.restore();
    }

    if (rawPoint) drawDebugCrosshair(ctx, rawPoint);
  };

  // Relative stamp geometry + visual state — not wall-clock time. A cursor that
  // only translates keeps this key, so the compositor repositions without a
  // canvas repaint / GPU upload.
  const contentKey = [
    settings.style,
    transition.shape,
    transition.prevShape,
    fadeIn.toFixed(2),
    pressScale.toFixed(3),
    idleOpacity.toFixed(3),
    settings.motionBlur.toFixed(2),
    settings.size.toFixed(2),
    baseH.toFixed(2),
    ...stamps.map(
      (s) =>
        `${(s.x - minX).toFixed(1)},${(s.y - minY).toFixed(1)},${s.alpha.toFixed(2)},${s.rotate.toFixed(3)}`,
    ),
    // The crosshair's offset within the layer is exactly the error being
    // measured, so it has to key the bitmap — otherwise a move-only frame
    // would reuse a bitmap baked at a different divergence.
    rawPoint
      ? `dbg:${(rawPoint.x - minX).toFixed(1)},${(rawPoint.y - minY).toFixed(1)}`
      : "",
  ].join("|");

  return {
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    contentKey,
    draw,
    placement: { height: baseH, stamps: placementStamps },
  };
}

/** ponytail: fails if parse defaults drift from product spec. */
export function assertCursorDefaults(): void {
  const d = DEFAULT_CURSOR_SETTINGS;
  console.assert(
    d.style === "tahoe" &&
      d.showCursor &&
      d.size >= 2 &&
      d.sway >= 0 &&
      d.clickEffect === "none",
  );
}

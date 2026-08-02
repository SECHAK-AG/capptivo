/**
 * Export settings — pure types + resolution/bitrate math.
 * UI and MediaRecorder / GIF plumbing live elsewhere.
 */

import { computeExportDimensionsForVideo } from "../lib/composition";

export type ExportFormat = "mp4" | "gif";
export type ExportContainer = "mp4" | "webm";
export type ExportEncoding = "fast" | "balanced" | "quality";
export type ExportFps = 24 | 30 | 60;
/** Voice-enhancement preset applied to the exported audio (ignored for GIF). */
export type ExportAudioEnhance = "off" | "podcast";

/**
 * GIF playback speed multiplier (timeline → wall-clock). 1 = real-time;
 * higher values sample fewer source frames and keep the same frame delay,
 * so the GIF finishes sooner and stays smaller. Ignored for video.
 */
export const GIF_SPEED_MIN = 1;
export const GIF_SPEED_MAX = 4;
export const GIF_SPEED_STEP = 0.25;
export const DEFAULT_GIF_SPEED = 1;

export function clampGifSpeed(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_GIF_SPEED;
  const clamped = Math.min(GIF_SPEED_MAX, Math.max(GIF_SPEED_MIN, n));
  const snapped = Math.round(clamped / GIF_SPEED_STEP) * GIF_SPEED_STEP;
  // Avoid 1.0000001-style float noise from the step multiply.
  return Math.round(snapped * 100) / 100;
}

export function formatGifSpeed(speed: number): string {
  return `${clampGifSpeed(speed)}×`;
}

export type ExportSettings = {
  format: ExportFormat;
  /** File container when format is video (ignored for GIF). */
  container: ExportContainer;
  encoding: ExportEncoding;
  fps: ExportFps;
  audioEnhance: ExportAudioEnhance;
  /** GIF-only playback speed (1…4). Ignored when format is video. */
  gifSpeed: number;
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: "mp4",
  container: "mp4",
  encoding: "balanced",
  fps: 30,
  audioEnhance: "off",
  gifSpeed: DEFAULT_GIF_SPEED,
};

/**
 * Output size comes straight from the composition stage (the aspect-ratio
 * picker in the timeline), capped per format: Full HD for video, and lower for
 * GIF because a Full HD GIF is enormous — the compositor still supersamples +
 * dithers, so these are the true output pixel dimensions.
 */
const VIDEO_LONG_EDGE = 1920;
const GIF_LONG_EDGE = 1280;

/** GIF frame rates — browser fps presets map down to GIF-friendly rates. */
const GIF_FPS_FOR_PRESET: Record<ExportFps, number> = {
  24: 12,
  30: 15,
  60: 20,
};

export function gifFpsForPreset(fps: ExportFps): number {
  return GIF_FPS_FOR_PRESET[fps];
}

const GIF_COLORS_FOR_ENCODING: Record<ExportEncoding, number> = {
  fast: 128,
  balanced: 256,
  quality: 256,
};

/**
 * Floyd–Steinberg dithering per tier. Dithering removes the gradient banding
 * that makes flat 256-colour GIFs look cheap, at the cost of a slower encode —
 * so only the "quality" tier pays for it.
 */
const GIF_DITHER_FOR_ENCODING: Record<ExportEncoding, boolean> = {
  fast: false,
  balanced: false,
  quality: true,
};

const ENCODING_BITRATE: Record<ExportEncoding, number> = {
  fast: 4_000_000,
  balanced: 8_000_000,
  quality: 16_000_000,
};

/** Reference pixel rate for "balanced" tiers (1080p @ 30 fps). */
const REF_PIXEL_RATE = 1920 * 1080 * 30;
const MIN_VIDEO_BITRATE = 500_000;
const MAX_VIDEO_BITRATE = 50_000_000;

function scaledVideoBitrate(
  encoding: ExportEncoding,
  width: number,
  height: number,
  fps: number,
): number {
  const base = ENCODING_BITRATE[encoding];
  const scale = (width * height * fps) / REF_PIXEL_RATE;
  const raw = Math.round(base * scale);
  return Math.max(
    MIN_VIDEO_BITRATE,
    Math.min(MAX_VIDEO_BITRATE, raw),
  );
}

/** Encoder output dims for the given stage: format long-edge cap + 16px align. */
export function exportDimensionsFor(
  stageWidth: number,
  stageHeight: number,
  format: ExportFormat = "mp4",
): { width: number; height: number } {
  const longEdge = format === "gif" ? GIF_LONG_EDGE : VIDEO_LONG_EDGE;
  return computeExportDimensionsForVideo(stageWidth, stageHeight, longEdge);
}

export type ResolvedExportParams = {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  /** Max palette size for GIF (ignored for video). */
  gifColors: number;
  /** Apply Floyd–Steinberg dithering when encoding GIF (ignored for video). */
  gifDither: boolean;
  /**
   * GIF playback speed (≥1). Encode samples the timeline at `fps / gifSpeed`
   * and keeps frame delay at `1/fps`, so output duration ≈ source / speed.
   */
  gifSpeed: number;
  format: ExportFormat;
  container: ExportContainer;
  ext: "mp4" | "webm" | "gif";
};

export function resolveExportParams(
  settings: ExportSettings,
  stageWidth: number,
  stageHeight: number,
): ResolvedExportParams {
  const { width, height } = exportDimensionsFor(stageWidth, stageHeight, settings.format);
  const isGif = settings.format === "gif";
  return {
    width,
    height,
    fps: isGif ? GIF_FPS_FOR_PRESET[settings.fps] : settings.fps,
    bitrate: isGif
      ? ENCODING_BITRATE[settings.encoding]
      : scaledVideoBitrate(settings.encoding, width, height, settings.fps),
    gifColors: GIF_COLORS_FOR_ENCODING[settings.encoding],
    gifDither: isGif && GIF_DITHER_FOR_ENCODING[settings.encoding],
    gifSpeed: isGif ? clampGifSpeed(settings.gifSpeed) : 1,
    format: settings.format,
    container: settings.container,
    ext: isGif ? "gif" : settings.container,
  };
}

/** Conservative bytes needed on disk before starting encode (video or GIF). */
export function estimateExportBytes(
  resolved: ResolvedExportParams,
  keptDurationSec: number,
): number {
  if (keptDurationSec <= 0) return 0;
  if (resolved.format === "gif") {
    // Palette frames are much smaller than raw pixels, but GIFs balloon —
    // use a generous floor so the precheck catches obvious shortfalls.
    // Speed shortens wall-clock output (fewer frames), so scale the estimate.
    const raw =
      (keptDurationSec / resolved.gifSpeed) *
      resolved.width *
      resolved.height *
      resolved.fps *
      0.15;
    return Math.max(64 * 1024 * 1024, Math.ceil(raw));
  }
  return Math.ceil((keptDurationSec * resolved.bitrate) / 8 * 1.2);
}

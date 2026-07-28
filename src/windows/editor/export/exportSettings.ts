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

export type ExportSettings = {
  format: ExportFormat;
  /** File container when format is video (ignored for GIF). */
  container: ExportContainer;
  encoding: ExportEncoding;
  fps: ExportFps;
  audioEnhance: ExportAudioEnhance;
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: "mp4",
  container: "mp4",
  encoding: "balanced",
  fps: 30,
  audioEnhance: "off",
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
    bitrate: ENCODING_BITRATE[settings.encoding],
    gifColors: GIF_COLORS_FOR_ENCODING[settings.encoding],
    gifDither: isGif && GIF_DITHER_FOR_ENCODING[settings.encoding],
    format: settings.format,
    container: settings.container,
    ext: isGif ? "gif" : settings.container,
  };
}

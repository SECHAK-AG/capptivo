/**
 * Composition + export sizing constants (ported from web editor).
 */

import type { ScreenContentCropNorm, ShadowPass } from "@/engine";
import { computeEffectiveSourceAspect } from "@/engine";

export const EXPORT_COMPOSITION = {
  width: 1920,
  height: 1080,
  devicePadding: 120,
} as const;

/** Recording drop-shadow stack — multi-pass ambient + contact edge. */
const RECORDING_SHADOW_LAYERS: readonly { sigma: number; opacity: number }[] = [
  { sigma: 48, opacity: 0.7 },
  { sigma: 16, opacity: 0.5 },
  { sigma: 8, opacity: 0.3 },
];

/** Short edge the layer sigmas above were authored against. */
const SHADOW_REFERENCE_EDGE = 1080;

/** Ceiling on a single pass, so the top of the slider stays a shadow. */
const MAX_SHADOW_PASS_OPACITY = 0.85;

/** Recording shadow passes for `intensity` (0–200 slider) at `shortEdge` px. */
export function recordingShadowPasses(
  intensity: number,
  shortEdge: number,
): readonly ShadowPass[] {
  const strength = Math.max(0, intensity / 100);
  if (strength <= 0) return [];

  const spread = (shortEdge / SHADOW_REFERENCE_EDGE) * strength;
  const density = strength <= 1 ? strength : 1 + (strength - 1) * 0.3;

  return RECORDING_SHADOW_LAYERS.map((layer) => ({
    sigma: layer.sigma * spread,
    opacity: Math.min(MAX_SHADOW_PASS_OPACITY, layer.opacity * density),
  }));
}

/** Default look values, matching the web editor's initial store state. */
export const DEFAULT_LOOK = {
  devicePadding: EXPORT_COMPOSITION.devicePadding,
  cornerRadius: 18,
  recordingShadowIntensity: 75,
  backgroundBlur: 9,
  backgroundDarkness: 15,
} as const;

/** H.264 hardware encoders require macroblock-aligned (multiple of 16) dims. */
export function alignEncoderDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const align = (value: number) =>
    Math.max(16, Math.floor(Math.max(1, value) / 16) * 16);
  return { width: align(width), height: align(height) };
}

/** Stage size that keeps the recording aspect exactly (long edge capped). */
export function computeStageDimensionsForVideo(
  videoWidth: number,
  videoHeight: number,
  maxLongEdge = 1920,
): { width: number; height: number } {
  const sourceWidth = Math.max(1, Math.round(videoWidth));
  const sourceHeight = Math.max(1, Math.round(videoHeight));
  const scale = maxLongEdge / Math.max(sourceWidth, sourceHeight);
  let width = Math.max(2, Math.round(sourceWidth * scale));
  let height = Math.max(2, Math.round(sourceHeight * scale));
  if (width % 2 !== 0) width += 1;
  if (height % 2 !== 0) height += 1;
  return { width, height };
}

/** Export encoder stage — preview aspect, dims snapped to 16px for H.264. */
export function computeExportDimensionsForVideo(
  videoWidth: number,
  videoHeight: number,
  maxLongEdge = 1920,
): { width: number; height: number } {
  const stage = computeStageDimensionsForVideo(
    videoWidth,
    videoHeight,
    maxLongEdge,
  );
  return alignEncoderDimensions(stage.width, stage.height);
}

/**
 * Max padding for the slider: a fraction of the composition's short edge so the
 * recording never shrinks to nothing.
 */
export function maxDevicePaddingFor(width: number, height: number): number {
  return Math.round(Math.min(width, height) * 0.4);
}

/**
 * Composition aspect-ratio presets (web editor's `ASPECT_RATIO_PRESETS`).
 * `recording` matches the source; the rest fix the stage — and therefore the
 * export — to the platform's canvas, so no separate export resolution exists.
 */
export type AspectRatioPresetId =
  | "recording"
  | "16:9"
  | "16:10"
  | "9:16"
  | "4:3"
  | "3:4"
  | "1:1"
  | "4:5"
  | "5:4"
  | "21:9"
  | "9:21";

export type AspectRatioPreset = {
  id: AspectRatioPresetId;
  label: string;
  width: number;
  height: number;
};

export const ASPECT_RATIO_PRESETS: readonly AspectRatioPreset[] = [
  { id: "recording", label: "Match", width: 1920, height: 1080 },
  { id: "16:9", label: "16:9", width: 1920, height: 1080 },
  { id: "16:10", label: "16:10", width: 1920, height: 1200 },
  { id: "9:16", label: "9:16", width: 1080, height: 1920 },
  { id: "4:3", label: "4:3", width: 1440, height: 1080 },
  { id: "3:4", label: "3:4", width: 1080, height: 1440 },
  { id: "1:1", label: "1:1", width: 1080, height: 1080 },
  { id: "4:5", label: "4:5", width: 1080, height: 1350 },
  { id: "5:4", label: "5:4", width: 1350, height: 1080 },
  { id: "21:9", label: "21:9", width: 2520, height: 1080 },
  { id: "9:21", label: "9:21", width: 1080, height: 2520 },
];

export const DEFAULT_ASPECT_RATIO_PRESET_ID: AspectRatioPresetId = "recording";

export function isAspectRatioPresetId(
  value: unknown,
): value is AspectRatioPresetId {
  return ASPECT_RATIO_PRESETS.some((p) => p.id === value);
}

/**
 * Single source of truth for composition stage size.
 * Crop affects inset/sampling only — not stage dimensions.
 */
export function resolveStageSize(
  presetId: AspectRatioPresetId,
  sourceVideoSize: { width: number; height: number } | null,
): { width: number; height: number } {
  if (presetId === "recording") {
    if (!sourceVideoSize) return { width: 1920, height: 1080 };
    return computeStageDimensionsForVideo(
      sourceVideoSize.width,
      sourceVideoSize.height,
    );
  }
  const preset =
    ASPECT_RATIO_PRESETS.find((p) => p.id === presetId) ??
    ASPECT_RATIO_PRESETS[0];
  return { width: preset.width, height: preset.height };
}

/** Zero padding for Match without an image background; otherwise use configured padding. */
export function resolvePreviewDevicePadding(
  presetId: AspectRatioPresetId,
  hasImageBackground: boolean,
  devicePadding: number,
): number {
  return presetId === "recording" && !hasImageBackground ? 0 : devicePadding;
}

/**
 * Aspect used to lay out the recording rect (`compositionSourceAspect`).
 * Content crop affects layout only when a background is selected; Match
 * without an image bg keeps the full file aspect.
 */
export function resolveCompositionSourceAspect(params: {
  presetId: AspectRatioPresetId;
  sourceAspect: number;
  sourceVideoSize: { width: number; height: number } | null;
  hasSelectedBackground: boolean;
  hasImageBackground: boolean;
  screenContentCrop?: ScreenContentCropNorm | null;
}): number {
  if (
    params.presetId === "recording" &&
    !params.hasImageBackground &&
    params.sourceVideoSize !== null
  ) {
    return params.sourceVideoSize.width / params.sourceVideoSize.height;
  }
  if (!params.hasSelectedBackground) {
    return params.sourceAspect;
  }
  const w = Math.max(1, params.sourceVideoSize?.width ?? 1);
  const h = Math.max(1, params.sourceVideoSize?.height ?? 1);
  return computeEffectiveSourceAspect({
    videoWidth: w,
    videoHeight: h,
    screenContentCrop: params.screenContentCrop,
  });
}

/** Device padding + layout aspect for preview/export compositors. */
export function resolveRecordingLayoutParams(params: {
  presetId: AspectRatioPresetId;
  sourceAspect: number;
  sourceVideoSize: { width: number; height: number } | null;
  hasSelectedBackground: boolean;
  hasImageBackground: boolean;
  devicePadding: number;
  screenContentCrop?: ScreenContentCropNorm | null;
}): { sourceAspect: number; devicePadding: number } {
  return {
    sourceAspect: resolveCompositionSourceAspect(params),
    devicePadding: params.hasSelectedBackground
      ? resolvePreviewDevicePadding(
          params.presetId,
          params.hasImageBackground,
          params.devicePadding,
        )
      : 0,
  };
}

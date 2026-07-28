export const FACE_CAM_COMPOSITION = {
  widthRatio: 0.2,
  minWidth: 120,
  maxWidth: 960,
  minHeight: 90,
  maxHeight: 720,
  /** Max corner radius for rectangular face cam (circle mode ignores this). */
  maxRoundness: 360,
  aspectRatio: 4 / 3,
  marginRatio: 0.04,
  minMargin: 10,
  cornerRadiusRatio: 0.12,
  shadowBlur: 24,
  shadowOffsetX: 0,
  shadowOffsetY: 10,
  shadowOpacity: 0.42,
} as const;

/** User-facing PiP edge inset (px). */
export const FACE_CAM_MARGIN_MIN = 0;
export const FACE_CAM_MARGIN_MAX = 96;
export const DEFAULT_FACE_CAM_MARGIN = 48;

/** Round face-cam diameter bounds (shared width/height clamp). */
export const FACE_CAM_ROUND_MIN = Math.max(
  FACE_CAM_COMPOSITION.minWidth,
  FACE_CAM_COMPOSITION.minHeight,
);
export const FACE_CAM_ROUND_MAX = Math.min(
  FACE_CAM_COMPOSITION.maxWidth,
  FACE_CAM_COMPOSITION.maxHeight,
);

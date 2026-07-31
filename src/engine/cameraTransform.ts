/**
 * Editor camera: one transform moves video, cursor, and shadow together.
 * `focus` is normalized 0–1 inside the recording rect (same space as zoom keyframes).
 *
 * Follow-cursor ease-in: fixed focus, scale ramps `1→S`, translation is
 * `progress * (centre − focus·S)` so the view zooms in place instead of
 * sliding the crop toward the seed.
 */

export type CameraRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Point to centre on, normalized 0–1 inside the recording rect. */
export type CameraFocus = { x: number; y: number };

/** Pixi-ready container transform: scale about the origin, then translate. */
export type CameraTransform = { scale: number; x: number; y: number };

export const CAMERA_IDENTITY: CameraTransform = { scale: 1, x: 0, y: 0 };

export type ComputeCameraTransformInput = {
  stageWidth: number;
  stageHeight: number;
  /** Where the unzoomed recording sits on the stage. */
  videoRect: CameraRect;
  focus: CameraFocus;
  /** Current (eased) scale. */
  scale: number;
  /**
   * Full zoom scale while easing in/out. When greater than `scale`, translation
   * uses progress·(centre − focus·targetScale) so ease-in zooms in place.
   * Omit (or pass === scale) for plateau / fixed-rect: classic scale-about-focus.
   */
  targetScale?: number;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Scale about the stage origin and translate so `focus` lands on the stage
 * centre (plateau). During ease-in with `targetScale`, uses a progress-scaled
 * final offset so the first zoom does not slide sideways.
 */
export function computeCameraTransform(
  input: ComputeCameraTransformInput,
): CameraTransform {
  const { stageWidth, stageHeight, videoRect, focus } = input;
  const scale = Math.max(1, input.scale);

  if (
    stageWidth <= 0 ||
    stageHeight <= 0 ||
    videoRect.width <= 0 ||
    videoRect.height <= 0 ||
    scale <= 1 + 1e-6
  ) {
    return CAMERA_IDENTITY;
  }

  const focusStageX = videoRect.x + focus.x * videoRect.width;
  const focusStageY = videoRect.y + focus.y * videoRect.height;
  const stageCenterX = stageWidth / 2;
  const stageCenterY = stageHeight / 2;

  const targetScale = Math.max(scale, input.targetScale ?? scale);
  // progress = 1 on plateau (targetScale === scale) → classic centre-on-focus.
  const progress =
    targetScale <= 1 + 1e-6
      ? 1
      : clamp01((scale - 1) / (targetScale - 1));

  return {
    scale,
    x: progress * (stageCenterX - focusStageX * targetScale),
    y: progress * (stageCenterY - focusStageY * targetScale),
  };
}

/** Map a stage point through the camera transform (geometry self-checks). */
export function applyCameraTransform(
  transform: CameraTransform,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: transform.x + point.x * transform.scale,
    y: transform.y + point.y * transform.scale,
  };
}

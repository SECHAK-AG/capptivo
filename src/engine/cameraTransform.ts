/**
 * Editor camera: one transform moves video, cursor, and shadow together.
 * `focus` is normalized 0–1 inside the recording rect (same space as zoom keyframes).
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
  scale: number;
};

/**
 * Scale about the stage origin and translate so `focus` lands on the stage
 * centre. Equivalent to scaling about the focus point, but expressed the way
 * a Pixi container wants it.
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

  return {
    scale,
    x: stageWidth / 2 - focusStageX * scale,
    y: stageHeight / 2 - focusStageY * scale,
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

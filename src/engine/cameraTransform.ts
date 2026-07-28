/**
 * The editor camera: one transform that moves everything anchored to the
 * recording.
 *
 * Zoom used to be two mechanisms — a source-texture crop for the video, and
 * separate arithmetic that re-derived where the cursor should land. Two
 * mechanisms have to agree, and they drifted: the cursor sat tens of pixels
 * from the pixel it pointed at, worsening with scale and with distance from the
 * zoom centre. There is no formula to keep in sync here. Video, cursor and
 * shadow are children of one container; the camera moves the container.
 *
 * `focus` is normalized to the **recording rect** — the same space
 * `zoomMotion` bakes its keyframes in, and the same space the cursor overlay is
 * placed in. That is the only coordinate space in the zoom path.
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

/**
 * Where a stage point ends up once the camera has moved. Only the geometry
 * self-check needs this — the renderer gets it for free from the scene graph,
 * which is the entire point of having a camera container.
 */
export function applyCameraTransform(
  transform: CameraTransform,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: transform.x + point.x * transform.scale,
    y: transform.y + point.y * transform.scale,
  };
}

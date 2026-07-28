/**
 * Create the shared preview/export frame compositor (Pixi / WebGPU|WebGL).
 *
 * Pixi is loaded lazily so sessions that never open the editor don't pay for
 * the bundle. Init failure throws — there is no Canvas2D compositor fallback.
 */

import type {
  FrameCompositor,
  FrameCompositorOptions,
} from "./frameCompositor";

export type {
  FrameCompositor,
  FrameCompositorOptions,
  FrameCompositorCaptions,
  FrameCompositorSurface,
} from "./frameCompositor";

export async function createFrameCompositor(
  options: FrameCompositorOptions,
): Promise<FrameCompositor> {
  const { createPixiFrameCompositor } = await import("./pixiCompositor");
  return await createPixiFrameCompositor(options);
}

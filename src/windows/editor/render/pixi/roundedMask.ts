/**
 * Rounded-rectangle clip for a sprite, as a stencil mask whose geometry is
 * rebuilt only when the rect actually changes.
 *
 * Pixi `Graphics` re-tessellates and re-uploads its vertex buffer on every
 * `clear()`, so rebuilding the mask each frame turns a free operation into a
 * per-frame buffer upload for something that is usually static. The rect only
 * moves when the layout does (padding easing during a zoom), so a signature
 * check skips almost all of that work.
 *
 * Corner antialiasing comes from the renderer's multisampling: the stencil test
 * runs per sample, so an MSAA target gives the same smooth corner Canvas2D's
 * `clip()` does. That is why the renderer is created with `antialias: true`.
 */

import { Graphics } from "pixi.js";

export class RoundedMask {
  readonly graphics = new Graphics();

  private x = NaN;
  private y = NaN;
  private width = NaN;
  private height = NaN;
  private radius = NaN;

  /** Reshape the mask; a no-op when the rect is unchanged. */
  set(x: number, y: number, width: number, height: number, radius: number): void {
    if (
      x === this.x &&
      y === this.y &&
      width === this.width &&
      height === this.height &&
      radius === this.radius
    ) {
      return;
    }
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.radius = radius;

    const g = this.graphics;
    g.clear();
    if (radius > 0) g.roundRect(x, y, width, height, radius);
    else g.rect(x, y, width, height);
    g.fill(0xffffff);
  }

  destroy(): void {
    this.graphics.destroy();
  }
}

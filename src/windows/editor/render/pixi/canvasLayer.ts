/**
 * A Canvas2D-painted layer that lives on the GPU as a Pixi sprite, and only
 * repaints + re-uploads when its content key changes.
 *
 * This is the single most important piece of the GPU compositor's budget. A
 * stage-sized RGBA canvas is ~8 MB; uploading one per layer per frame
 * (background + cursor + captions) costs more bus traffic than Canvas2D spends
 * drawing the whole frame, which is exactly why a naive Pixi port comes out
 * *slower* than the 2D path it replaced. Here every layer declares a key over
 * the inputs that actually change its pixels — a frame whose key is unchanged
 * does no CPU painting and no upload at all.
 *
 * Layers are also placed and sized independently of the stage, so a layer can
 * cover just the region it draws into (see the cursor overlay, which is a few
 * hundred pixels square rather than full-stage).
 */

import { CanvasSource, Sprite, Texture } from "pixi.js";

export type CanvasLayerPlacement = {
  /** Stage-space rect the layer occupies, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CanvasLayerUpdate = CanvasLayerPlacement & {
  /**
   * Identifies the pixels to paint. `null` hides the layer; an unchanged key
   * (with unchanged placement) reuses the texture as-is.
   */
  key: string | null;
  /**
   * Bitmap pixels per stage pixel. Layers that end up magnified by a scene
   * zoom raster at that zoom so they stay as sharp as drawing them directly
   * under the transform would have been. Defaults to 1.
   */
  pixelScale?: number;
  /**
   * Paint the layer. The context is already cleared and transformed so that
   * drawing in *stage* coordinates lands correctly inside the layer's rect.
   */
  draw: (ctx: CanvasRenderingContext2D) => void;
};

export class CanvasLayer {
  readonly sprite: Sprite;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly source: CanvasSource;
  private key: string | null = null;
  private bitmapWidth = 0;
  private bitmapHeight = 0;
  private originX = 0;
  private originY = 0;

  constructor(label: string) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1;
    this.canvas.height = 1;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error(`canvas layer "${label}": no 2d context`);
    this.ctx = ctx;

    this.source = new CanvasSource({
      resource: this.canvas,
      // The canvas is authored in stage pixels; no extra density.
      resolution: 1,
      autoDensity: false,
      label,
    });
    this.sprite = new Sprite(new Texture({ source: this.source, label }));
    this.sprite.visible = false;
  }

  update(update: CanvasLayerUpdate): void {
    if (update.key === null || update.width <= 0 || update.height <= 0) {
      this.sprite.visible = false;
      this.key = null;
      return;
    }

    // Bitmap covers the placement rect; the sprite is then positioned so that
    // pixel (0,0) of the canvas sits at (x, y) on the stage.
    const scale = update.pixelScale ?? 1;
    const w = Math.max(1, Math.ceil(update.width * scale));
    const h = Math.max(1, Math.ceil(update.height * scale));
    const resized = w !== this.bitmapWidth || h !== this.bitmapHeight;
    // Move-only updates (same content key, same bitmap size) just reposition
    // the sprite — the cursor does this every frame while the glyph is still.
    // Redrawing on every move was the whole per-frame canvas upload cost.
    const contentChanged = update.key !== this.key;

    if (resized || contentChanged) {
      if (resized) {
        // CanvasSource.resize() resizes the backing canvas, which clears it.
        this.source.resize(w, h, 1);
        this.bitmapWidth = w;
        this.bitmapHeight = h;
      } else {
        this.ctx.clearRect(0, 0, w, h);
      }

      this.ctx.save();
      this.ctx.scale(scale, scale);
      this.ctx.translate(-update.x, -update.y);
      update.draw(this.ctx);
      this.ctx.restore();

      this.source.update();
      this.key = update.key;
    }

    this.originX = update.x;
    this.originY = update.y;
    this.sprite.visible = true;
    this.sprite.position.set(update.x, update.y);
    this.sprite.setSize(w / scale, h / scale);
  }

  /**
   * Hide without repainting. The key is cleared too, so whatever comes back
   * later repaints even if it happens to carry the key we last drew.
   */
  hide(): void {
    this.sprite.visible = false;
    this.key = null;
  }

  destroy(): void {
    this.sprite.destroy({ texture: true, textureSource: true });
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}

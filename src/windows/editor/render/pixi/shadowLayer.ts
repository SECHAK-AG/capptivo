/**
 * A baked drop-shadow sprite (recording frame, face-cam PiP).
 *
 * Blurring is expensive but a shadow is fully determined by rect size, corner
 * radius and intensity — stable across frames. Bake once behind a key; a steady
 * shadow is one quad per frame.
 *
 * **Never resize a canvas that is bound to a live Pixi `CanvasSource`.** Doing
 * so (the old `bake(liveCanvas)` path) invalidates the GPU texture underneath
 * the sprite mid-frame; WebGPU's next present then throws
 * `program.layout[groupIndex]` on a null program and the whole preview goes
 * black. Keep a stable GPU canvas and only allocate a new one when pixel size
 * changes.
 */

import { CanvasSource, Sprite, Texture } from "pixi.js";

import type { ShadowSprite } from "@/engine";

export type ShadowLayerUpdate = {
  /** Everything the bake depends on. `null` hides the shadow. */
  key: string | null;
  /** Bake the sprite, reusing the previous *scratch* canvas when possible. */
  bake: (reuse: HTMLCanvasElement | null) => ShadowSprite;
  /** Top-left of the rect the shadow sits behind, in stage pixels. */
  x: number;
  y: number;
  /** Stretch applied when the live rect differs from the baked one. */
  scaleX?: number;
  scaleY?: number;
};

export class ShadowLayer {
  readonly sprite = new Sprite(Texture.EMPTY);

  /** Scratch for CPU bakes — never attached to a GPU source. */
  private scratch: HTMLCanvasElement | null = null;
  /** Stable canvas uploaded to the GPU. */
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private source: CanvasSource | null = null;
  private key: string | null = null;
  private pad = 0;
  private drawWidth = 0;
  private drawHeight = 0;

  constructor(private readonly label: string) {
    this.sprite.visible = false;
  }

  update(update: ShadowLayerUpdate): void {
    if (update.key === null) {
      this.sprite.visible = false;
      return;
    }

    if (update.key !== this.key || !this.source || !this.canvas) {
      this.rebake(update.bake);
      this.key = update.key;
    }

    if (!this.canvas || !this.source) {
      this.sprite.visible = false;
      return;
    }

    const scaleX = update.scaleX ?? 1;
    const scaleY = update.scaleY ?? 1;
    this.sprite.visible = true;
    this.sprite.position.set(
      update.x - this.pad * scaleX,
      update.y - this.pad * scaleY,
    );
    this.sprite.setSize(this.drawWidth * scaleX, this.drawHeight * scaleY);
  }

  private rebake(bake: ShadowLayerUpdate["bake"]): void {
    // Scratch may be resized freely — it is not a GPU resource.
    const baked = bake(this.scratch);
    this.scratch = baked.canvas;
    this.pad = baked.pad;
    this.drawWidth = baked.width;
    this.drawHeight = baked.height;

    const bw = Math.max(1, baked.canvas.width);
    const bh = Math.max(1, baked.canvas.height);

    if (
      this.canvas &&
      this.ctx &&
      this.source &&
      this.canvas.width === bw &&
      this.canvas.height === bh
    ) {
      // Same GPU allocation: blit scratch → stable canvas, re-upload pixels.
      this.ctx.clearRect(0, 0, bw, bh);
      this.ctx.drawImage(baked.canvas, 0, 0);
      this.source.update();
      return;
    }

    // Pixel size changed: new GPU canvas, swap, then free the old.
    const next = document.createElement("canvas");
    next.width = bw;
    next.height = bh;
    const ctx = next.getContext("2d");
    if (!ctx) {
      this.sprite.visible = false;
      return;
    }
    ctx.drawImage(baked.canvas, 0, 0);

    const previous = this.sprite.texture;
    this.canvas = next;
    this.ctx = ctx;
    this.source = new CanvasSource({
      resource: next,
      resolution: 1,
      autoDensity: false,
      label: this.label,
    });
    this.sprite.texture = new Texture({
      source: this.source,
      label: this.label,
    });
    previous.destroy(true);
  }

  destroy(): void {
    this.sprite.destroy({ texture: true, textureSource: true });
    this.source = null;
    this.canvas = null;
    this.ctx = null;
    this.scratch = null;
  }
}

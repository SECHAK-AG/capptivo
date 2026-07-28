/**
 * Cursor glyphs as Pixi sprites, parented under the camera container.
 *
 * Tip position is always in *unzoomed* recording-rect space; the camera's
 * scale/translate is the only zoom. A spring chases the recorded tip between
 * frames; clicks and seeks snap so the tip still lands on the button.
 */

import { Container, Graphics, Sprite, Texture } from "pixi.js";
import {
  CursorMotionState,
  cursorBounceScale,
  cursorClickFxProgress,
  nearCursorClick,
  type CursorClickEffectId,
} from "@/engine/cursorMotion";
import type { CursorAsset, CursorPlacementFrame } from "@/engine";

export type PixiCursorUpdate = {
  placement: CursorPlacementFrame | null;
  timeSec: number;
  /** Seek / scrub / pause — snap the spring. */
  freeze: boolean;
  videoRect: { x: number; y: number; width: number; height: number };
  smoothness: number;
  sway: number;
  motionBlur: number;
  /** 0–0.4 bounce intensity (settings.clickShrink). */
  clickShrink: number;
  clickEffect: CursorClickEffectId;
  pressIntervals: readonly { start: number; end: number }[] | undefined;
};

export class PixiCursorOverlay {
  readonly container = new Container({ label: "cursor" });

  private readonly motion = new CursorMotionState();
  private readonly pool: Sprite[] = [];
  private readonly fx = new Graphics({ label: "cursor-fx" });
  private readonly textures = new WeakMap<object, Texture>();

  constructor() {
    this.container.addChild(this.fx);
  }

  update(input: PixiCursorUpdate): void {
    const { placement } = input;
    if (!placement || placement.stamps.length === 0) {
      this.hide();
      return;
    }

    this.container.visible = true;
    const { videoRect: rect } = input;
    const rw = Math.max(1e-9, rect.width);
    const rh = Math.max(1e-9, rect.height);

    const heads = headStamps(placement.stamps);
    const head = heads[heads.length - 1]!;
    const targetNdc = {
      x: (head.x - rect.x) / rw,
      y: (head.y - rect.y) / rh,
    };

    const smoothed = this.motion.update(targetNdc, input.timeSec, {
      smoothness: input.smoothness,
      sway: input.sway,
      motionBlur: input.motionBlur,
      freeze: input.freeze,
      nearClick: nearCursorClick(input.pressIntervals, input.timeSec),
    });

    const bounce = cursorBounceScale(
      input.pressIntervals,
      input.timeSec,
      input.clickShrink,
    );

    const tipX = rect.x + smoothed.x * rw;
    const tipY = rect.y + smoothed.y * rh;

    const rendered: CursorPlacementFrame["stamps"] = [];
    const trailLen = smoothed.trail.length;
    for (let i = trailLen - 1; i >= 0; i -= 1) {
      const p = smoothed.trail[i]!;
      const age = (i + 1) / (trailLen + 1);
      rendered.push({
        x: rect.x + p.x * rw,
        y: rect.y + p.y * rh,
        alpha:
          head.alpha * 0.22 * (1 - age) * Math.min(1, input.motionBlur + 0.15),
        rotate: 0,
        pressScale: 1,
        asset: head.asset,
      });
    }
    for (const s of heads) {
      rendered.push({
        x: tipX,
        y: tipY,
        alpha: s.alpha,
        rotate: smoothed.rotation,
        pressScale: bounce,
        asset: s.asset,
      });
    }

    this.drawStamps(placement.height, rendered);
    this.drawFx(
      tipX,
      tipY,
      placement.height * bounce,
      cursorClickFxProgress(input.pressIntervals, input.timeSec),
      input.clickEffect,
    );
  }

  hide(): void {
    for (const s of this.pool) s.visible = false;
    this.fx.clear();
    this.container.visible = false;
  }

  destroy(): void {
    for (const s of this.pool) s.destroy();
    this.pool.length = 0;
    this.fx.destroy();
    this.container.destroy({ children: false });
  }

  private drawStamps(
    height: number,
    stamps: CursorPlacementFrame["stamps"],
  ): void {
    while (this.pool.length < stamps.length) {
      const sprite = new Sprite();
      this.pool.push(sprite);
      this.container.addChild(sprite);
    }
    if (this.fx.parent === this.container) {
      this.container.setChildIndex(this.fx, 0);
    }

    for (let i = 0; i < this.pool.length; i += 1) {
      const sprite = this.pool[i]!;
      const stamp = stamps[i];
      if (!stamp) {
        sprite.visible = false;
        continue;
      }

      const texture = this.textureFor(stamp.asset);
      if (sprite.texture !== texture) sprite.texture = texture;

      const aspect =
        stamp.asset.image.naturalHeight > 0
          ? stamp.asset.image.naturalWidth / stamp.asset.image.naturalHeight
          : 1;
      const h = height * stamp.pressScale;
      const w = h * aspect;

      sprite.anchor.set(stamp.asset.anchorX, stamp.asset.anchorY);
      sprite.setSize(w, h);
      sprite.alpha = stamp.alpha;
      sprite.rotation = stamp.rotate;
      sprite.position.set(stamp.x, stamp.y);
      sprite.visible = true;
    }
  }

  private drawFx(
    px: number,
    py: number,
    cursorSize: number,
    progress: number,
    effect: CursorClickEffectId,
  ): void {
    this.fx.clear();
    if (effect === "none" || progress <= 0) return;

    const reveal = 1 - progress;
    const alpha = progress;
    const color = 0x2563eb;
    const baseRadius = Math.max(12, cursorSize * 0.55);
    const strokeWidth = Math.max(2, cursorSize * 0.08);

    if (effect === "ripple") {
      const radius = Math.max(
        0.5,
        (1 - Math.pow(progress, 1.35)) * cursorSize * 1.95,
      );
      const a = Math.max(0, Math.min(1, Math.pow(progress, 3) * 0.6));
      this.fx.circle(px, py, radius);
      this.fx.stroke({
        width: Math.max(1, 2 * progress),
        color,
        alpha: a,
      });
      return;
    }

    if (effect === "spotlight") {
      const glowRadius = baseRadius + reveal * cursorSize;
      const innerRadius = Math.max(baseRadius * 0.72, glowRadius * 0.76);
      this.fx.circle(px, py, glowRadius);
      this.fx.stroke({
        width: Math.max(1.25, strokeWidth * 0.68),
        color,
        alpha: alpha * 0.28,
      });
      this.fx.circle(px, py, innerRadius);
      this.fx.stroke({
        width: Math.max(1.5, strokeWidth * 0.75),
        color,
        alpha: alpha * 0.5,
      });
      return;
    }

    const echoOuter = baseRadius + reveal * cursorSize * 1.22;
    const echoInner = Math.max(baseRadius * 0.58, echoOuter * 0.62);
    this.fx.circle(px, py, echoOuter);
    this.fx.stroke({ width: strokeWidth, color, alpha: alpha * 0.72 });
    this.fx.circle(px, py, echoInner);
    this.fx.stroke({
      width: Math.max(1.4, strokeWidth * 0.72),
      color,
      alpha: alpha * 0.42,
    });
    this.fx.circle(px, py, Math.max(3, baseRadius * 0.18));
    this.fx.fill({ color, alpha: alpha * 0.14 });
  }

  private textureFor(asset: CursorAsset): Texture {
    const key = asset.image as object;
    const hit = this.textures.get(key);
    if (hit) return hit;
    const texture = Texture.from(asset.image);
    this.textures.set(key, texture);
    return texture;
  }
}

/** Last stamp, or last two when they share a tip (shape crossfade). */
function headStamps(
  stamps: CursorPlacementFrame["stamps"],
): CursorPlacementFrame["stamps"] {
  const n = stamps.length;
  if (n === 0) return [];
  if (
    n >= 2 &&
    stamps[n - 1]!.x === stamps[n - 2]!.x &&
    stamps[n - 1]!.y === stamps[n - 2]!.y &&
    stamps[n - 1]!.asset !== stamps[n - 2]!.asset
  ) {
    return stamps.slice(n - 2);
  }
  return stamps.slice(n - 1);
}

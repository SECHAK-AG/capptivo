/**
 * Presents the composed scene at the output resolution.
 *
 * The scene is always composed at the *composition reference* size (1920 long
 * edge) because every look value the user tunes — device padding, face-cam
 * size, corner radius, caption font size — is an absolute pixel number
 * calibrated against it. Outputs smaller than that (GIF) therefore need a
 * downscale, and doing it with a Canvas2D `drawImage` off the GPU canvas is a
 * full stall: it forces a readback, a CPU resample and a re-upload for every
 * frame.
 *
 * So we keep it on the GPU. The scene renders into a render texture, which is
 * then blitted down in successive halving steps before the final step to the
 * output canvas. Halving is what makes it a *box* filter rather than a sparse
 * bilinear tap: a single bilinear step from 1920 → 800 samples 4 texels out of
 * every ~6, which aliases exactly where fine UI text lives.
 *
 * When output size == composition size (all video exports and the preview) the
 * scene renders straight to the canvas and none of this runs.
 */

import { Container, RenderTexture, Sprite, type Renderer } from "pixi.js";

/** Never halve past this ratio — below it a direct bilinear step is exact enough. */
const HALVING_STOP_RATIO = 1.6;

export class OutputSurface {
  private sceneTarget: RenderTexture | null = null;
  private steps: RenderTexture[] = [];
  private readonly blit = new Sprite();

  constructor(
    private readonly renderer: Renderer,
    private compositionWidth: number,
    private compositionHeight: number,
    private outputWidth: number,
    private outputHeight: number,
  ) {
    this.rebuild();
  }

  get needsDownscale(): boolean {
    return this.sceneTarget !== null;
  }

  resize(
    compositionWidth: number,
    compositionHeight: number,
    outputWidth: number,
    outputHeight: number,
  ): void {
    if (
      compositionWidth === this.compositionWidth &&
      compositionHeight === this.compositionHeight &&
      outputWidth === this.outputWidth &&
      outputHeight === this.outputHeight
    ) {
      return;
    }
    this.compositionWidth = compositionWidth;
    this.compositionHeight = compositionHeight;
    this.outputWidth = outputWidth;
    this.outputHeight = outputHeight;
    this.release();
    this.rebuild();
  }

  /** Render `stage` (authored in composition pixels) to the output canvas. */
  present(stage: Container): void {
    const target = this.sceneTarget;
    if (!target) {
      this.renderer.render(stage);
      return;
    }

    this.renderer.render({ container: stage, target, clear: true });

    let source = target;
    for (const step of this.steps) {
      source = this.drawTo(source, step);
    }
    this.blit.texture = source;
    this.blit.setSize(this.outputWidth, this.outputHeight);
    this.renderer.render({ container: this.blit, clear: true });
  }

  destroy(): void {
    this.release();
    this.blit.destroy();
  }

  private drawTo(source: RenderTexture, target: RenderTexture): RenderTexture {
    this.blit.texture = source;
    this.blit.setSize(target.width, target.height);
    this.renderer.render({ container: this.blit, target, clear: true });
    return target;
  }

  private rebuild(): void {
    if (
      this.compositionWidth === this.outputWidth &&
      this.compositionHeight === this.outputHeight
    ) {
      return;
    }

    this.sceneTarget = RenderTexture.create({
      width: this.compositionWidth,
      height: this.compositionHeight,
      // Antialiasing lives on the scene target now that it is what the masks
      // and geometry are rasterized into.
      antialias: true,
      label: "composition",
    });

    // Intermediate halving steps, stopping before the final blit gets close
    // enough that one bilinear step is faithful.
    let width = this.compositionWidth;
    let height = this.compositionHeight;
    while (width / this.outputWidth > HALVING_STOP_RATIO) {
      width = Math.max(this.outputWidth, Math.round(width / 2));
      height = Math.max(this.outputHeight, Math.round(height / 2));
      this.steps.push(
        RenderTexture.create({ width, height, label: `downscale-${width}x${height}` }),
      );
    }
  }

  private release(): void {
    this.sceneTarget?.destroy(true);
    this.sceneTarget = null;
    for (const step of this.steps) step.destroy(true);
    this.steps = [];
  }
}

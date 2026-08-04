/**
 * The frame compositor contract shared by preview and export.
 *
 * Composition size and output size are separate on purpose. Every look value
 * the user tunes — device padding, corner radius, face-cam size, caption font
 * size — is an absolute pixel number calibrated against the 1920-long-edge
 * composition reference, so a smaller output (a GIF) must be *composed* at the
 * reference and then downscaled, never composed small.
 */

import type { RenderFrameInputs } from "./renderFrame";
import type { CaptionCue } from "@/captions/types";
import type { CaptionSettings } from "@/captions/settings";

export type FrameCompositorCaptions = {
  captions: CaptionCue[];
  settings: CaptionSettings;
  /** Caption clock in milliseconds (matches drawCaptions). */
  timeMs: number;
};

export type FrameCompositorOptions = {
  /** Composition reference size; look values are calibrated in these pixels. */
  width: number;
  height: number;
  /** Encoder / display size. Defaults to the composition size. */
  outputWidth?: number;
  outputHeight?: number;
  /**
   * Keep an output-sized CPU-readable copy of each frame, for GIF
   * quantization and Path B rawvideo → ffmpeg. Other MP4 paths leave this
   * off so pixels stay on the GPU.
   */
  cpuReadback?: boolean;
  /**
   * Retain the GPU drawing buffer past `compose()`. Required whenever the
   * canvas is handed to something else (the WebCodecs encoder) after the
   * compositor returns. Preview can leave this off.
   */
  preserveDrawingBuffer?: boolean;
  /**
   * Render into an `OffscreenCanvas` instead of a DOM-capable one.
   *
   * A canvas-backed GPU context is on the browser's *presentation* path: each
   * frame goes through the swap chain, and asking for the next drawing surface
   * blocks until a previous frame has been presented — i.e. it paces itself to
   * the display's refresh rate. That is exactly right for the preview and
   * catastrophic for an export loop, which wants to run flat out. An offscreen
   * surface has no presentation path and no such pacing.
   *
   * When `requireOffscreen` is set, failure to create a GPU context on an
   * OffscreenCanvas throws instead of falling back to a presentation-paced DOM
   * canvas.
   */
  offscreen?: boolean;
  /**
   * Fail hard if an offscreen GPU surface cannot be created. Export sets this
   * so a silent DOM fallback cannot pace the loop to ~display refresh.
   */
  requireOffscreen?: boolean;
  /**
   * Multisample antialias for rounded-corner stencil masks. Preview: on.
   * Export: off — MSAA cost with no interactive benefit at fixed output size.
   */
  antialias?: boolean;
  /**
   * Generate mipmaps when source video out-resolves the stage. Opt-in —
   * regenerating the chain on every upload usually costs more than it saves.
   * Preview and export leave this off.
   */
  mipmaps?: boolean;
  /**
   * GPU backends to try, in order. Preview should use `["webgl","webgpu"]`
   * — WebGPU on WKWebView regularly dies mid-frame with a null shader program
   * (`program.layout[groupIndex]`), blacking the stage. Preview should prefer
   * WebGL. Export may prefer WebGPU (VideoFrame uploads) with WebGL fallback.
   */
  gpuPreference?: ReadonlyArray<"webgl" | "webgpu">;
  /** Collect per-phase timings; see `stats()`. Export only — see ComposeProfiler. */
  profile?: boolean;
};

/** Where composed frames land: the DOM shows one, the encoder captures either. */
export type FrameCompositorSurface = HTMLCanvasElement | OffscreenCanvas;

export type FrameCompositor = {
  /** Output-sized bitmap the encoder captures or the DOM displays. */
  canvas: FrameCompositorSurface;
  /**
   * 2D context over `canvas` when `cpuReadback` is on, for `getImageData`.
   * Null otherwise — WebCodecs MP4/WebM paths never read pixels back.
   *
   * Prefer {@link FrameCompositor.readPixelsInto} for anything in a per-frame
   * loop: this route costs a GPU→CPU blit into a software canvas *plus* a
   * second copy out of it.
   */
  readback: CanvasRenderingContext2D | null;
  /**
   * Copy the current output-sized frame into `target` as RGBA, straight off the
   * GPU. Returns `false` when the active renderer cannot do it (a WebGPU
   * backend, or a Pixi version that no longer exposes its GL context), so
   * callers can fall back rather than break.
   *
   * `target.length` must be exactly `outputWidth * outputHeight * 4`.
   *
   * Rows arrive **bottom-up**, because that is how `glReadPixels` defines its
   * origin. The consumer owns the flip — see `export_rawvideo.rs`, which hands
   * FFmpeg a `vflip` filter so the correction folds into a pixel-format
   * conversion it was already doing, instead of costing a full extra copy in JS.
   */
  readPixelsInto(target: Uint8Array): boolean;
  backend: "pixi";
  resize(
    width: number,
    height: number,
    outputWidth?: number,
    outputHeight?: number,
  ): void;
  compose(
    inputs: RenderFrameInputs,
    captions?: FrameCompositorCaptions | null,
  ): void;
  /** Per-phase averages when `profile` was set, else null. */
  stats(): string | null;
  /** GPU texture upload / skip counts when the backend tracks them. */
  uploadStats(): { uploads: number; skipped: number } | null;
  dispose(): void;
};

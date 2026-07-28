/**
 * Binds a decoded image — an `HTMLVideoElement`, a `VideoFrame` straight out of
 * WebCodecs, or a canvas — to a single long-lived Pixi texture, plus a cropped
 * view of it for zoom/pan.
 *
 * Two things matter here:
 *
 * 1. **The GPU texture is created once and re-uploaded in place.** Decoding
 *    hands us a brand-new `VideoFrame` object every frame; allocating a texture
 *    per frame would thrash the GPU allocator. Swapping the source's `resource`
 *    keeps the same texture and turns each frame into a `texSubImage2D` /
 *    `copyExternalImageToTexture` — no CPU round trip through a canvas.
 * 2. **Identical samples skip the upload.** `VideoFrame` identity equality
 *    covers the export path. Preview `<video>` elements use the RVFC stamp from
 *    `videoFrameTrack` (presentedFrames + seek generation) so VFR captures and
 *    paused look-tweaks do not re-upload unchanged pixels.
 * 3. **Minification is mipmapped only when opted in.** Recordings often
 *    out-resolve the stage; mipmaps kill shimmer, but regenerating the chain on
 *    every upload dominates compose. Export and preview leave them off — turn
 *    on only when interactive shimmer is worth the cost.
 */

import {
  CanvasSource,
  ImageSource,
  Rectangle,
  Texture,
  VideoSource,
} from "pixi.js";

import {
  videoFrameStamp,
  videoStampNeedsUpload,
  type UploadedVideoStamp,
} from "../videoFrameTrack.ts";

/** Anything the decode paths can hand the compositor for one frame. */
export type DecodedImage = HTMLVideoElement | HTMLCanvasElement | VideoFrame;

export type DecodedSize = { width: number; height: number };

export type SourceTextureOptions = {
  /**
   * Generate mipmaps when the source out-resolves the stage. Opt-in — regen
   * cost on every upload usually exceeds the shimmer win for preview/export.
   */
  mipmaps?: boolean;
};

/** Minification beyond this factor is worth paying for mipmaps (when enabled). */
const MIPMAP_MINIFICATION_THRESHOLD = 1.15;

function isVideoFrame(value: unknown): value is VideoFrame {
  return typeof VideoFrame !== "undefined" && value instanceof VideoFrame;
}

/** `HTMLMediaElement.HAVE_CURRENT_DATA` — pixels exist for the current position. */
const HAVE_CURRENT_DATA = 2;

/**
 * Whether uploading this element would actually move pixels to the GPU.
 *
 * `videoWidth` turns non-zero at `HAVE_METADATA`, one readyState *before* the
 * first sample is decoded, so an element can be bindable while still having
 * nothing to draw.
 */
function hasDecodedPixels(video: HTMLVideoElement): boolean {
  return video.readyState >= HAVE_CURRENT_DATA;
}

function isVideoElement(value: unknown): value is HTMLVideoElement {
  return (
    typeof HTMLVideoElement !== "undefined" && value instanceof HTMLVideoElement
  );
}

function sizeOf(image: DecodedImage): DecodedSize {
  if (isVideoFrame(image)) {
    return { width: image.displayWidth, height: image.displayHeight };
  }
  if (isVideoElement(image)) {
    return { width: image.videoWidth, height: image.videoHeight };
  }
  return { width: image.width, height: image.height };
}

/**
 * Whether an immutable frame reference must be uploaded given what is already
 * on the GPU. Same object → skip; different object → upload.
 */
export function immutableFrameNeedsUpload(
  boundTo: unknown,
  image: unknown,
): boolean {
  return boundTo !== image;
}

/**
 * Whether `bind` must upload pixels for `image` given what is already on the GPU.
 *
 * `VideoFrame` pixels are immutable — identity equality means a skip.
 * `HTMLVideoElement` pixels mutate in place — use the RVFC stamp when the
 * caller has started `trackVideoFrames`; untracked elements always upload.
 * Canvases always upload (pixels mutate under a stable reference).
 */
export function needsGpuUpload(
  boundTo: DecodedImage | null,
  image: DecodedImage,
  boundVideoStamp: UploadedVideoStamp | null = null,
): boolean {
  if (isVideoFrame(image)) return immutableFrameNeedsUpload(boundTo, image);
  if (isVideoElement(image)) {
    return videoStampNeedsUpload(boundVideoStamp, videoFrameStamp(image));
  }
  return true;
}

export class SourceTexture {
  private source: VideoSource | CanvasSource | ImageSource | null = null;
  private base: Texture | null = null;
  private cropped: Texture | null = null;
  private boundTo: DecodedImage | null = null;
  private boundVideoStamp: UploadedVideoStamp | null = null;
  private size: DecodedSize = { width: 0, height: 0 };
  private uploads = 0;
  private skipped = 0;
  private readonly label: string;
  private readonly stageLongEdge: number;
  private readonly mipmaps: boolean;

  /**
   * @param stageLongEdge Longest stage edge this texture is composited into —
   * only used to decide whether mipmaps are worth generating when enabled.
   */
  constructor(
    label: string,
    stageLongEdge: number,
    options: SourceTextureOptions = {},
  ) {
    this.label = label;
    this.stageLongEdge = stageLongEdge;
    this.mipmaps = options.mipmaps === true;
  }

  /** Cumulative upload / skip counts since construction (or last `resetStats`). */
  stats(): { uploads: number; skipped: number } {
    return { uploads: this.uploads, skipped: this.skipped };
  }

  resetStats(): void {
    this.uploads = 0;
    this.skipped = 0;
  }

  /**
   * Point at this frame's decoded pixels, uploading them to the GPU when they
   * actually changed. Returns the source size, or `null` when there is nothing
   * decodable yet.
   */
  bind(image: DecodedImage | null): DecodedSize | null {
    if (!image) {
      this.release();
      return null;
    }
    const size = sizeOf(image);
    if (size.width <= 0 || size.height <= 0) {
      this.release();
      return null;
    }

    const reusable =
      this.source !== null &&
      this.size.width === size.width &&
      this.size.height === size.height &&
      // Elements and canvases are stable objects we keep pointing at; a
      // VideoFrame is a fresh object each *distinct* sample, so size+kind
      // gates texture reuse while identity gates the upload below.
      (isVideoFrame(image)
        ? isVideoFrame(this.boundTo)
        : this.boundTo === image);

    if (!reusable) {
      this.release();
      this.source = this.createSource(image, size);
      this.base = new Texture({ source: this.source, label: this.label });
      this.size = size;
      this.rememberBound(image);
      this.source.update();
      this.uploads += 1;
      return size;
    }

    if (!needsGpuUpload(this.boundTo, image, this.boundVideoStamp)) {
      this.skipped += 1;
      return size;
    }

    if (isVideoFrame(image)) {
      // Same texture, new frame: swap the upload resource in place.
      this.source!.resource = image;
    }

    this.rememberBound(image);
    this.source!.update();
    this.uploads += 1;
    return size;
  }

  /**
   * A texture showing `rect` (in source pixels) of the bound image. The
   * returned texture is reused across frames — callers must not destroy it.
   */
  crop(rect: Rectangle): Texture {
    const base = this.base;
    if (!base)
      throw new Error(`${this.label}: crop() before a successful bind()`);

    if (!this.cropped || this.cropped.source !== base.source) {
      this.cropped?.destroy(false);
      this.cropped = new Texture({
        source: base.source,
        frame: rect.clone(),
        label: `${this.label}:crop`,
        dynamic: true,
      });
      return this.cropped;
    }

    const frame = this.cropped.frame;
    if (
      frame.x !== rect.x ||
      frame.y !== rect.y ||
      frame.width !== rect.width ||
      frame.height !== rect.height
    ) {
      frame.copyFrom(rect);
      // `update()`, not `updateUvs()`: the sprite only re-packs its batched
      // vertices when the texture emits, so skipping the event leaves the zoom
      // crop one frame stale (or frozen entirely).
      this.cropped.update();
    }
    return this.cropped;
  }

  destroy(): void {
    this.release();
  }

  private rememberBound(image: DecodedImage): void {
    this.boundTo = image;
    if (isVideoElement(image)) {
      // Only claim an upload once the element really had pixels. A bind at
      // HAVE_METADATA uploads an empty texture; recording a stamp for it would
      // let the RVFC gate skip every later upload and leave that blank texture
      // frozen on the stage (background and face-cam keep drawing, so the
      // screen layer simply vanishes). A null stamp forces the next compose to
      // upload for real — `loadeddata` / `seeked` already schedule one.
      const stamp = hasDecodedPixels(image) ? videoFrameStamp(image) : null;
      this.boundVideoStamp = stamp
        ? {
            presentedFrames: stamp.presentedFrames,
            generation: stamp.generation,
          }
        : null;
      return;
    }
    this.boundVideoStamp = null;
  }

  private createSource(
    image: DecodedImage,
    size: DecodedSize,
  ): VideoSource | CanvasSource | ImageSource {
    // Mipmaps prevent the shimmer bilinear leaves when a retina capture is
    // minified onto a smaller stage. They are not free: Pixi regenerates the
    // whole chain on every upload, which is a render pass per level — so this
    // shows up in the profiler's `screenUpload` phase and is the first thing
    // to check when compositing is slow.
    const minification = Math.max(size.width, size.height) / this.stageLongEdge;
    const autoGenerateMipmaps =
      this.mipmaps && minification > MIPMAP_MINIFICATION_THRESHOLD;
    console.info(
      `[compositor] ${this.label} texture ${size.width}x${size.height} ` +
        `minification=${minification.toFixed(2)}x mipmaps=${autoGenerateMipmaps}`,
    );

    if (isVideoElement(image)) {
      // Pixi's VideoSource defaults to autoPlay + rAF-driven updates. Both are
      // wrong here: playback is owned by the editor's clock, and the export
      // path has no rAF at all — frames are pulled explicitly by `bind()`.
      const source = new VideoSource({
        resource: image,
        autoPlay: false,
        autoLoad: false,
        updateFPS: 0,
        label: this.label,
        autoGenerateMipmaps,
      });
      source.autoUpdate = false;
      return source;
    }

    if (isVideoFrame(image)) {
      return new ImageSource({
        resource: image,
        width: size.width,
        height: size.height,
        label: this.label,
        autoGenerateMipmaps,
        // Frames are swapped every tick; never let the GC unload underneath us.
        autoGarbageCollect: false,
      });
    }

    return new CanvasSource({
      resource: image,
      resolution: 1,
      autoDensity: false,
      label: this.label,
      autoGenerateMipmaps,
    });
  }

  private release(): void {
    this.cropped?.destroy(false);
    this.cropped = null;
    this.base?.destroy(false);
    this.base = null;
    if (this.source) {
      // The decoded sample is never ours to tear down — detach it so Pixi's
      // destroy() is a pure GPU teardown:
      //
      // - A VideoFrame belongs to the decoder and may already be closed.
      // - A <video> belongs to React. VideoSource.destroy() pauses it, sets
      //   `src = ""` and calls load() — that fires MEDIA_ERR_SRC_NOT_SUPPORTED
      //   and permanently kills playback, because React never re-assigns an
      //   unchanged `src` prop. Any compositor remount would black the stage.
      //   We build these with `autoLoad: false`, so VideoSource never attached
      //   the listeners its destroy() removes: detaching costs us nothing.
      if (this.source instanceof VideoSource) {
        this.source.autoUpdate = false;
        this.source.resource = null as unknown as HTMLVideoElement;
      } else if (this.source instanceof ImageSource) {
        this.source.resource = null as unknown as VideoFrame;
      }
      this.source.destroy();
    }
    this.source = null;
    this.boundTo = null;
    this.boundVideoStamp = null;
    this.size = { width: 0, height: 0 };
  }
}

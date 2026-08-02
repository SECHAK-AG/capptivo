/**
 * Binds decoded images to a long-lived Pixi texture with crop support.
 * Re-uploads in place; skips identical samples (VideoFrame identity / RVFC stamp).
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
  /** Generate mipmaps when source out-resolves the stage (opt-in). */
  mipmaps?: boolean;
};

/** Minification beyond this factor is worth paying for mipmaps (when enabled). */
const MIPMAP_MINIFICATION_THRESHOLD = 1.15;

function isVideoFrame(value: unknown): value is VideoFrame {
  return typeof VideoFrame !== "undefined" && value instanceof VideoFrame;
}

/** `HTMLMediaElement.HAVE_CURRENT_DATA` — pixels exist for the current position. */
const HAVE_CURRENT_DATA = 2;

/** Whether this element has decodable pixels (not just metadata). */
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

/** True when `image` is a different immutable frame than `boundTo`. */
export function immutableFrameNeedsUpload(
  boundTo: unknown,
  image: unknown,
): boolean {
  return boundTo !== image;
}

/** Whether `bind` must upload given what is already on the GPU. */
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
   * @param stageLongEdge Longest stage edge — used for mipmap threshold when enabled.
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

  /** Upload when pixels changed; returns source size or `null`. */
  bind(image: DecodedImage | null): DecodedSize | null {
    if (!image) {
      this.release();
      return null;
    }
    // WKWebView sets videoWidth after metadata while GPU upload stays blank.
    // Refuse until HAVE_CURRENT_DATA so face-cam does not show shadow-only.
    if (isVideoElement(image) && !hasDecodedPixels(image)) {
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
      this.source!.resource = image;
    }

    this.rememberBound(image);
    this.source!.update();
    this.uploads += 1;
    return size;
  }

  /** Cropped view of the bound image; reused across frames — do not destroy. */
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
    const minification = Math.max(size.width, size.height) / this.stageLongEdge;
    const autoGenerateMipmaps =
      this.mipmaps && minification > MIPMAP_MINIFICATION_THRESHOLD;
    console.info(
      `[compositor] ${this.label} texture ${size.width}x${size.height} ` +
        `minification=${minification.toFixed(2)}x mipmaps=${autoGenerateMipmaps}`,
    );

    if (isVideoElement(image)) {
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
      // Detach decoded samples before destroy — React owns `<video>` elements.
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

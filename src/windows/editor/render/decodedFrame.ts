/**
 * Where the compositor gets a frame's pixels from.
 *
 * Preview draws from real `<video>` elements. Export decodes with WebCodecs and
 * hands the compositor a `VideoFrame` per frame, wrapped in a canvas stand-in
 * that satisfies the `HTMLVideoElement` shape the render path expects (see
 * `export/frameSurface.ts`). The GPU compositor wants the `VideoFrame` itself —
 * uploading it directly is what removes the decode → Canvas2D → texture round
 * trip — so surfaces register a provider here and the compositor asks for it by
 * element.
 *
 * Deliberately free of any decoder types: this is the seam between the render
 * layer and whatever produced the pixels.
 */

import type { DecodedImage } from "./pixi/sourceTexture";

export type { DecodedImage };

/** Returns this tick's pixels, or `null` when nothing has been decoded yet. */
export type DecodedImageProvider = () => DecodedImage | null;

const providers = new WeakMap<object, DecodedImageProvider>();

/** Register `element` as a stand-in backed by `provider`. */
export function registerDecodedFrameSource(
  element: HTMLVideoElement,
  provider: DecodedImageProvider,
): void {
  providers.set(element, provider);
}

export function unregisterDecodedFrameSource(element: HTMLVideoElement): void {
  providers.delete(element);
}

/**
 * The pixels to upload for `media`: a registered surface's current frame, or
 * the element itself when it is a real one.
 */
export function decodedImageFor(
  media: HTMLVideoElement | null | undefined,
): DecodedImage | null {
  if (!media) return null;
  const provider = providers.get(media);
  return provider ? provider() : media;
}

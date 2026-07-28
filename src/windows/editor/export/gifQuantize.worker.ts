/**
 * GIF quantization worker — runs gifenc quantize/applyPalette (and optional
 * Floyd–Steinberg dither) off the main thread. Same functions and parameters
 * as the main-thread path; only the thread changes. Output must stay
 * byte-identical (see plans/020).
 *
 * `ditherApplyPalette` reuses an internal index buffer, so the reply always
 * transfers a *copy* — sending the reused buffer would corrupt the next frame.
 */

import { applyPalette, quantize } from "gifenc";
import { createDitherPalettizer } from "./gifDither";

export type GifQuantizeRequest = {
  id: number;
  width: number;
  height: number;
  colors: number;
  dither: boolean;
  rgba: ArrayBuffer;
};

export type GifQuantizeResponse = {
  id: number;
  palette: number[][];
  index: ArrayBuffer;
};

type DitherFn = ReturnType<typeof createDitherPalettizer>;

let ditherApplyPalette: DitherFn | null = null;
let ditherGeo: { width: number; height: number } | null = null;

const FORMAT = "rgb565" as const;

self.onmessage = (event: MessageEvent<GifQuantizeRequest>) => {
  const { id, width, height, colors, dither, rgba } = event.data;
  const data = new Uint8ClampedArray(rgba);

  if (dither) {
    if (!ditherApplyPalette || !ditherGeo || ditherGeo.width !== width || ditherGeo.height !== height) {
      ditherApplyPalette = createDitherPalettizer(width, height);
      ditherGeo = { width, height };
    }
  }

  const palette = quantize(data, colors, { format: FORMAT });
  const index = dither && ditherApplyPalette
    ? ditherApplyPalette(data, palette)
    : applyPalette(data, palette, FORMAT);

  // Always copy — dither returns a reused buffer; applyPalette may too.
  const indexCopy = index.slice();
  const response: GifQuantizeResponse = {
    id,
    palette,
    index: indexCopy.buffer,
  };
  // Worker postMessage transfer-list form (second arg is Transferable[]).
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(
    response,
    [indexCopy.buffer],
  );
};

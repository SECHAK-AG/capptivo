declare module "gifenc" {
  export type RGBPalette = number[][];

  export type QuantizeOptions = {
    format?: "rgb565" | "rgb444" | "rgba4444";
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  };

  export type GifFrameOptions = {
    palette?: RGBPalette;
    delay?: number;
    repeat?: number;
    transparent?: boolean | number;
    dispose?: number;
  };

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): RGBPalette;

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: RGBPalette,
    format?: QuantizeOptions["format"],
  ): Uint8Array;

  /**
   * The encoder's underlying byte buffer. `reset()` here rewinds only the
   * buffer (unlike the encoder's own `reset()`, which also re-emits the GIF
   * header), so it can be drained to disk at frame boundaries during streaming.
   */
  export type GIFByteStream = {
    bytesView: () => Uint8Array;
    reset: () => void;
  };

  export type GIFEncoderInstance = {
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      opts?: GifFrameOptions,
    ) => void;
    finish: () => void;
    bytes: () => Uint8Array;
    bytesView: () => Uint8Array;
    reset: () => void;
    readonly stream: GIFByteStream;
  };

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;
}

/**
 * MP4 export route selection — which encode backend to try first.
 *
 * Windows defaults to Path B (Pixi compose + ffmpeg encode) so WebView2
 * VideoEncoder is skipped. macOS/Linux keep WebCodecs-first for speed.
 * Force Path B anywhere with `VITE_CAPPTIVO_RAWVIDEO_EXPORT=1`.
 *
 * Pure on purpose — selfchecks run under plain Node without Vite aliases.
 */

/** Prefer RGBA → ffmpeg encode over WebCodecs Annex-B. */
export function shouldPreferFfmpegRawvideoEncode(
  windows: boolean,
  force: boolean,
): boolean {
  return force || windows;
}

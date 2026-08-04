/**
 * MP4 export route selection.
 *
 * Contract:
 * - Everywhere: Annex-B WebCodecs → ffmpeg `-c copy` (Breeze-style mux).
 * - Windows (WebView2): software WebCodecs only, DOM canvas, stall → one
 *   RGBA→ffmpeg escape, never in-webview mux. HW WebCodecs is unreliable.
 * - macOS/Linux: prefer-hardware first; in-webview mux allowed as last resort.
 *
 * Pure on purpose — selfchecks run under plain Node without Vite aliases.
 */

export type AnnexBHwMode =
  | "prefer-hardware"
  | "no-preference"
  | "prefer-software";

/**
 * WebCodecs hardwareAcceleration probe order for Annex-B export.
 * Windows never probes prefer-hardware (WebView2 stalls mid-export).
 */
export function annexBHardwareProbeOrder(
  windows: boolean,
): readonly AnnexBHwMode[] {
  if (windows) {
    return ["prefer-software", "no-preference"];
  }
  return ["prefer-hardware", "no-preference", "prefer-software"];
}

/**
 * OffscreenCanvas export surface. Off on Windows — dual GL + Offscreen is a
 * WebView2 context-loss magnet; DOM canvas + GPU Pixi is the stable contract.
 */
export function shouldUseOffscreenExportCanvas(input: {
  windows: boolean;
  /** Session latch after a prior Offscreen/context-loss failure. */
  sessionPreferDom: boolean;
  /** Explicit caller override (`false` forces DOM). */
  optionOffscreen?: boolean;
}): boolean {
  if (input.windows) return false;
  if (input.sessionPreferDom) return false;
  if (input.optionOffscreen === false) return false;
  return true;
}

/** Force RGBA → ffmpeg encode as the first attempt (debug / support only). */
export function shouldForceFfmpegRawvideoEncode(force: boolean): boolean {
  return force;
}

/**
 * After Annex-B is missing or fails, try RGBA → ffmpeg encode once.
 * Not retried if it was already forced as the first attempt.
 */
export function shouldTryFfmpegRawvideoFallback(
  forceAlreadyTried: boolean,
): boolean {
  return !forceAlreadyTried;
}

/**
 * In-webview mediabunny/MediaRecorder MP4 mux. Safe on WKWebView; on WebView2
 * it is the documented Windows crash/encoding-error mode.
 */
export function shouldAllowInWebviewMp4Mux(windows: boolean): boolean {
  return !windows;
}

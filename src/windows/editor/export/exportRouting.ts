/**
 * MP4 export route selection.
 *
 * Primary path everywhere (incl. Windows): WebCodecs Annex-B → ffmpeg `-c copy`
 * — compressed chunks over IPC, same shape as Recordly breeze. The old Windows
 * default (RGBA → ffmpeg re-encode) ships ~8 MB/frame and triggers WebView2 TDR.
 *
 * RGBA Path B is opt-in (`VITE_CAPPTIVO_RAWVIDEO_EXPORT=1`) or a last-resort
 * when Annex-B is unavailable. In-webview mediabunny MP4 mux is disabled on
 * Windows (documented failure mode).
 *
 * Pure on purpose — selfchecks run under plain Node without Vite aliases.
 */

/** Force RGBA → ffmpeg encode as the first attempt. */
export function shouldForceFfmpegRawvideoEncode(force: boolean): boolean {
  return force;
}

/**
 * After Annex-B is missing or fails, try RGBA → ffmpeg encode.
 * Always available as the native escape hatch (encode outside the webview).
 */
export function shouldTryFfmpegRawvideoFallback(forceAlreadyTried: boolean): boolean {
  // If the user forced Path B first and it failed, don't retry the same path.
  return !forceAlreadyTried;
}

/**
 * In-webview mediabunny/MediaRecorder MP4 mux. Safe on WKWebView; on WebView2
 * it is the documented Windows crash/encoding-error mode.
 */
export function shouldAllowInWebviewMp4Mux(windows: boolean): boolean {
  return !windows;
}

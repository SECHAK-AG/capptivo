/**
 * MP4 export route selection — the single place that decides how a file gets
 * encoded.
 *
 * There are exactly two routes, and both composite with the same Pixi
 * compositor the preview uses, so they are WYSIWYG-identical:
 *
 * - `annexb-ffmpeg` — WebCodecs H.264 (Annex-B) in the WebView → ffmpeg
 *   `-c:v copy`. Only compressed bytes cross IPC and nothing re-encodes. This is
 *   the fast path and it is preferred everywhere it can be *proven* to work
 *   (see `annexBProbe.ts` — declared support is not proof).
 * - `rgba-ffmpeg` — RGBA readback → ffmpeg hardware H.264 (nvenc/qsv/amf/mf/
 *   videotoolbox/vaapi, probed natively in `hw_encoder.rs`). Needs no WebCodecs
 *   whatsoever, which is what makes it a universal floor.
 *
 * What is deliberately *not* here any more: in-webview mediabunny MP4 muxing and
 * the MediaRecorder capture path. Both wrote MP4 bytes from inside the WebView,
 * both were the documented WebView2 failure mode, and MediaRecorder additionally
 * had to rewrite the user's chosen `.mp4` path to `.webm` when it could only
 * produce WebM. Fewer routes is the feature: every extra route is another
 * combination that works on one machine and not the next.
 *
 * Pure on purpose — selfchecks run under plain Node without Vite aliases.
 */

export type AnnexBHwMode =
  | "prefer-hardware"
  | "no-preference"
  | "prefer-software";

/**
 * WebCodecs `hardwareAcceleration` probe order for Annex-B export.
 *
 * Windows does not lead with `prefer-hardware`: WebView2's hardware H.264
 * encoder is the one that accepts frames and silently stops emitting chunks.
 * Software H.264 is not the slow choice it sounds like here — compositing runs
 * on the GPU either way, and a 1080p30 software encode outruns the compositor on
 * any machine that can run the editor. `no-preference` still lets the driver
 * offer hardware where it is healthy.
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
 * OffscreenCanvas export surface. Off on Windows — a second GL context plus
 * OffscreenCanvas is a WebView2 context-loss magnet, and DOM canvas + GPU Pixi
 * is the combination that survives there.
 */
export function shouldUseOffscreenExportCanvas(input: {
  windows: boolean;
  /** Session latch after a prior Offscreen/context-loss failure. */
  sessionPreferDom: boolean;
}): boolean {
  if (input.windows) return false;
  if (input.sessionPreferDom) return false;
  return true;
}

export type Mp4Route = "annexb-ffmpeg" | "rgba-ffmpeg";

/**
 * The ordered routes to attempt for one MP4 export.
 *
 * `rgba-ffmpeg` is always last and always present: it is the route with no
 * WebCodecs dependency, so it is the one that must not be reachable-only-
 * sometimes. A caller that exhausts this list has a genuine failure to report,
 * not another fallback to invent.
 */
export function planMp4Routes(input: {
  /** A *verified* Annex-B encoder exists (not merely a declared one). */
  annexBVerified: boolean;
  /** Support/debug override: skip WebCodecs entirely. */
  forceRgba: boolean;
}): readonly Mp4Route[] {
  if (input.forceRgba) return ["rgba-ffmpeg"];
  if (input.annexBVerified) return ["annexb-ffmpeg", "rgba-ffmpeg"];
  return ["rgba-ffmpeg"];
}

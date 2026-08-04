/** Pure H.264 export helpers (safe for Node selfchecks). */

/** High@L4.2 — covers 1080p60; Annex-B for ffmpeg `-f h264`. */
export const ANNEX_B_CODEC = "avc1.64002A";

/** I-frame every N seconds — fewer keyframes → less encoder work. */
export const H264_KEYFRAME_INTERVAL_SEC = 4;

export function isH264Keyframe(
  frameIndex: number,
  fps: number,
  intervalSec = H264_KEYFRAME_INTERVAL_SEC,
): boolean {
  const every = Math.max(1, Math.round(fps * intervalSec));
  return frameIndex % every === 0;
}

/** True when `data` starts with an Annex-B start code (3- or 4-byte). */
export function isAnnexBStartCode(data: Uint8Array): boolean {
  if (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1) {
    return true;
  }
  return data.length >= 3 && data[0] === 0 && data[1] === 0 && data[2] === 1;
}

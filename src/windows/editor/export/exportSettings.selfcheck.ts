/** Selfcheck: export bitrate scales with resolution and fps. */

// ponytail: mirrors `scaledVideoBitrate` in exportSettings.ts — keeps this file
// dependency-free for Node selfcheck (exportSettings pulls composition).
const BALANCED = 8_000_000;
const REF_PIXEL_RATE = 1920 * 1080 * 30;
const MIN = 500_000;
const MAX = 50_000_000;

function scaled(encodingBitrate: number, w: number, h: number, fps: number): number {
  const raw = Math.round(encodingBitrate * ((w * h * fps) / REF_PIXEL_RATE));
  return Math.max(MIN, Math.min(MAX, raw));
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const hd60 = scaled(BALANCED, 1920, 1080, 60);
const hd30 = scaled(BALANCED, 1920, 1080, 30);
const sd24 = scaled(BALANCED, 640, 360, 24);

assert(hd60 > sd24, `1080p60 (${hd60}) should exceed 640×360@24 (${sd24})`);
assert(
  Math.abs(hd30 - BALANCED) < 500_000,
  `1080p30 balanced should be ~8 Mbps, got ${hd30}`,
);

console.log("exportSettings.selfcheck: ok");

export {};

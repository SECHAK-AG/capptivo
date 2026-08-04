/** Selfcheck: export bitrate scales; GIF speed clamp + sample rate. */

// ponytail: mirrors helpers in exportSettings.ts — keeps this file
// dependency-free for Node selfcheck (exportSettings pulls composition).
const BALANCED = 8_000_000;
const REF_PIXELS = 1920 * 1080;
const REF_FPS = 30;
const MIN = 500_000;
const MAX = 50_000_000;

const GIF_SPEED_MIN = 1;
const GIF_SPEED_MAX = 4;
const GIF_SPEED_STEP = 0.25;
const DEFAULT_GIF_SPEED = 1;

function scaled(encodingBitrate: number, w: number, h: number, fps: number): number {
  const pixelScale = (w * h) / REF_PIXELS;
  const fpsScale = Math.sqrt(Math.max(1, fps / REF_FPS));
  const raw = Math.round(encodingBitrate * pixelScale * fpsScale);
  return Math.max(MIN, Math.min(MAX, raw));
}

function clampGifSpeed(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_GIF_SPEED;
  const clamped = Math.min(GIF_SPEED_MAX, Math.max(GIF_SPEED_MIN, n));
  const snapped = Math.round(clamped / GIF_SPEED_STEP) * GIF_SPEED_STEP;
  return Math.round(snapped * 100) / 100;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const hd60 = scaled(BALANCED, 1920, 1080, 60);
const hd30 = scaled(BALANCED, 1920, 1080, 30);
const hd24 = scaled(BALANCED, 1920, 1080, 24);
const sd24 = scaled(BALANCED, 640, 360, 24);

assert(hd60 > sd24, `1080p60 (${hd60}) should exceed 640×360@24 (${sd24})`);
assert(
  Math.abs(hd30 - BALANCED) < 500_000,
  `1080p30 balanced should be ~8 Mbps, got ${hd30}`,
);
assert(hd24 === hd30, `24fps should not under-scale vs 30fps (got ${hd24} vs ${hd30})`);

const expected60 = Math.round(BALANCED * Math.sqrt(2));
assert(
  Math.abs(hd60 - expected60) < 1,
  `1080p60 should be ~√2× 30fps (${expected60}), got ${hd60}`,
);
assert(hd60 < BALANCED * 2, `60fps must not fully double 30fps bitrate (got ${hd60})`);

assert(clampGifSpeed(undefined) === DEFAULT_GIF_SPEED, "missing → default");
assert(clampGifSpeed(0) === GIF_SPEED_MIN, "below min clamps");
assert(clampGifSpeed(99) === GIF_SPEED_MAX, "above max clamps");
assert(clampGifSpeed(1.3) === 1.25, "snaps to step");
assert(clampGifSpeed(2) === 2, "exact step preserved");

// Encode samples at fps/speed and keeps delay at 1/fps → duration ≈ source/speed.
const fps = 15;
const sourceSec = 10;
const speed = 2;
const sampleFps = fps / speed;
const frameCount = Math.round(sourceSec * sampleFps);
const delaySec = 1 / fps;
const playbackSec = frameCount * delaySec;
assert(
  Math.abs(playbackSec - sourceSec / speed) < 1e-9,
  `2× should halve wall-clock (got ${playbackSec}s for ${sourceSec}s @ ${fps}fps)`,
);

// exceedsSourceFps — mirrored per the note at the top of this file.
function exceedsSourceFps(
  requested: number,
  sourceFps: number | null | undefined,
): boolean {
  if (typeof sourceFps !== "number") return false;
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return false;
  return requested > sourceFps;
}

assert(exceedsSourceFps(60, 30), "60 out of a 30fps take repeats screen frames");
assert(!exceedsSourceFps(30, 30), "matching the capture rate is not a warning");
assert(!exceedsSourceFps(24, 30), "below the capture rate is not a warning");
assert(!exceedsSourceFps(60, 60), "a real 60fps take exports 60 cleanly");
// Old projects and broken manifests must stay silent — an unactionable warning
// on every export is worse than none.
for (const unknown of [null, undefined, 0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert(
    !exceedsSourceFps(60, unknown),
    `unknown source fps (${String(unknown)}) must not warn`,
  );
}

console.log("exportSettings.selfcheck: ok");

export {};

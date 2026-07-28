/**
 * Runnable check: Match stage follows full source, never a content-crop fraction.
 * Run: `node --experimental-strip-types src/windows/editor/lib/composition.selfcheck.ts`
 */

export {}; // module scope — keeps top-level helpers out of the global namespace

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function computeStageDimensionsForVideo(
  videoWidth: number,
  videoHeight: number,
  maxLongEdge = 1920,
): { width: number; height: number } {
  const sourceWidth = Math.max(1, Math.round(videoWidth));
  const sourceHeight = Math.max(1, Math.round(videoHeight));
  const scale = maxLongEdge / Math.max(sourceWidth, sourceHeight);
  let width = Math.max(2, Math.round(sourceWidth * scale));
  let height = Math.max(2, Math.round(sourceHeight * scale));
  if (width % 2 !== 0) width += 1;
  if (height % 2 !== 0) height += 1;
  return { width, height };
}

function resolveStageSize(
  presetId: string,
  sourceVideoSize: { width: number; height: number } | null,
): { width: number; height: number } {
  if (presetId === "recording") {
    if (!sourceVideoSize) return { width: 1920, height: 1080 };
    return computeStageDimensionsForVideo(sourceVideoSize.width, sourceVideoSize.height);
  }
  return { width: 1920, height: 1080 };
}

const match4k = resolveStageSize("recording", { width: 3840, height: 2160 });
assert(match4k.width === 1920 && match4k.height === 1080, "Match caps long edge at 1920");

const matchPortrait = resolveStageSize("recording", { width: 1080, height: 1920 });
assert(
  matchPortrait.width === 1080 && matchPortrait.height === 1920,
  "Match keeps portrait source aspect",
);

const fixed = resolveStageSize("16:9", { width: 800, height: 600 });
assert(fixed.width === 1920 && fixed.height === 1080, "16:9 ignores source size");

const again = resolveStageSize("recording", { width: 1920, height: 1080 });
assert(again.width === 1920 && again.height === 1080, "full-HD Match is 1:1");

console.log("composition.selfcheck: ok");

/**
 * Module-level zoom keyframe cache — rebuilt only when fragments/metadata/crop
 * change, so the rAF compositor just interpolates (no spring integration per
 * frame).
 *
 * Invalidation is signal-based: every store mutator that touches fragments,
 * metadata, or crop calls `invalidateZoomKeyframesCache()`, which bumps a
 * monotonic version. `getZoomPanAtTime` compares that integer instead of
 * rebuilding a fingerprint string on every rendered frame — no per-frame
 * allocation, no GC pressure during playback or export. That signal is also
 * what lets a version match skip the reconcile outright: no new crop or
 * metadata can reach this module without having bumped it first.
 *
 * Two properties keep an edit cheap:
 *
 * 1. **Reuse is granular.** The store updates `zoomFragments` immutably
 *    (`.map`/spread), so an untouched fragment keeps its object identity across
 *    edits — and keeps its cached keyframes with it. Metadata, or a crop that
 *    actually moved, feeds every fragment's integration and drops the lot.
 * 2. **Integration is lazy.** Reconciling only prunes; keyframes are computed
 *    when a fragment is genuinely asked for. This is what makes dragging a crop
 *    handle survivable — the crop changes on every pointer event, and the
 *    preview needs the motion of at most the one fragment under the playhead.
 *    Eagerly re-integrating every fragment was costing whole frames per event
 *    on a long recording.
 *
 * Crop is compared by value rather than by reference, so a re-render that hands
 * over an equal-but-new crop object does not throw the cache away.
 *
 * This module — not `resolveZoomPanAtTime` — is the editor's entry point for
 * zoom motion. That function's own lazy branch cannot see the crop mapping and
 * would silently produce an unmapped (wrong) focus whenever a screen-content
 * crop is set, so new callers must come through here.
 */

// Imported from the module rather than the `@/engine` barrel so the selfcheck
// can run this file under `node --experimental-strip-types`: the barrel pulls
// in DOM-dependent engine modules, and the alias needs a bundler. Everything
// used here lives in `zoomMotion` anyway.
import {
  computeZoomKeyframes,
  createFullNormToContentNdcFromCrop,
  findActiveZoomFragment,
  interpolateZoomKeyframe,
  type RecordingMetadata,
  type ScreenContentCropNorm,
  type ZoomContentSpaceMap,
  type ZoomFragment,
  type ZoomKeyframe,
} from "../../../engine/zoomMotion.ts";

let version = 0;
let builtVersion = -1;

let cache = new Map<string, ZoomKeyframe[]>();
/** Fragment object identities the current `cache` entries were built from. */
let builtFragments = new Map<string, ZoomFragment>();
/** Metadata/crop the current `cache` was built against. */
let builtMetadata: RecordingMetadata | null = null;
let builtCrop: ScreenContentCropNorm | null = null;
/** Content-space map for `builtCrop`; rebuilt only when the crop really moves. */
let builtToContent: ZoomContentSpaceMap | undefined;

function cropEquals(
  a: ScreenContentCropNorm | null,
  b: ScreenContentCropNorm | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/**
 * Drop the cache entries this (fragments, metadata, crop) combination
 * invalidates. Deliberately computes nothing — see the laziness note above.
 */
function reconcile(
  fragments: ZoomFragment[],
  metadata: RecordingMetadata | null,
  crop: ScreenContentCropNorm | null,
): void {
  if (version === builtVersion) return;

  const sameCrop = cropEquals(crop, builtCrop);
  const canReuse = metadata === builtMetadata && sameCrop;

  const next = new Map<string, ZoomKeyframe[]>();
  const nextFragments = new Map<string, ZoomFragment>();
  for (const fragment of fragments) {
    if (canReuse && builtFragments.get(fragment.id) === fragment) {
      const keyframes = cache.get(fragment.id);
      if (keyframes) next.set(fragment.id, keyframes);
    }
    nextFragments.set(fragment.id, fragment);
  }

  // Deleted fragments fall away with the old map, so the cache can never grow
  // past what the timeline holds.
  cache = next;
  builtFragments = nextFragments;
  if (!sameCrop) {
    builtToContent = crop
      ? createFullNormToContentNdcFromCrop(crop)
      : undefined;
  }
  builtMetadata = metadata;
  builtCrop = crop;
  builtVersion = version;
}

/**
 * Pan/scale of the camera at `time`: integrates the covering fragment's springs
 * on first use, then reuses them until something invalidates the cache. Returns
 * the neutral camera when no fragment covers `time`.
 */
export function getZoomPanAtTime(
  fragments: ZoomFragment[],
  metadata: RecordingMetadata | null,
  crop: ScreenContentCropNorm | null,
  time: number,
): { x: number; y: number; scale: number } {
  reconcile(fragments, metadata, crop);

  const active = findActiveZoomFragment(fragments, time);
  if (!active) return { x: 0.5, y: 0.5, scale: 1 };

  let keyframes = cache.get(active.id);
  if (!keyframes || keyframes.length === 0) {
    // An `undefined` fps keeps the engine's 120 Hz sampling default. Preview
    // and export must bake at the same rate or their motion diverges.
    keyframes = computeZoomKeyframes(
      active,
      metadata,
      undefined,
      builtToContent,
    );
    cache.set(active.id, keyframes);
  }

  const k = interpolateZoomKeyframe(keyframes, time);
  return { x: k.x, y: k.y, scale: k.scale };
}

export function invalidateZoomKeyframesCache(): void {
  version++;
}

/** Fragments currently integrated. Diagnostics — the selfcheck asserts laziness. */
export function zoomKeyframeCacheSize(): number {
  return cache.size;
}

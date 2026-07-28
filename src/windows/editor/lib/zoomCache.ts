/**
 * Zoom keyframe cache — rebuilt on invalidation, lazy per-fragment integration.
 * Editor entry point for zoom motion (handles crop mapping).
 */

// Direct import for selfcheck under `node --experimental-strip-types` (barrel pulls DOM).
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

/** Prune stale entries; does not integrate keyframes (lazy). */
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

/** Pan/scale at `time`; neutral camera when no fragment covers `time`. */
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

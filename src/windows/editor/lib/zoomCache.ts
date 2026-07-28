/**
 * Module-level zoom keyframe cache — rebuilt only when fragments/metadata/crop
 * change, so the rAF compositor just interpolates (no spring integration per
 * frame).
 *
 * Invalidation is signal-based: every store mutator that touches fragments,
 * metadata, or crop calls `invalidateZoomKeyframesCache()`, which bumps a
 * monotonic version. `getZoomKeyframesMap` compares that integer instead of
 * rebuilding a fingerprint string on every rendered frame — no per-frame
 * allocation, no GC pressure during playback or export.
 *
 * Rebuilds are *granular*: editing one fragment only recomputes that fragment.
 * The store updates `zoomFragments` immutably (`.map`/spread), so an untouched
 * fragment keeps its object identity across edits. On rebuild we reuse the
 * cached keyframes for any fragment whose identity is unchanged, and only run
 * the (expensive) `computeZoomKeyframes` spring integration for the ones that
 * actually changed. Metadata or crop changing affects every fragment, so a new
 * reference for either forces a full recompute.
 */

import {
  computeZoomKeyframes,
  createFullNormToContentNdcFromCrop,
  type RecordingMetadata,
  type ScreenContentCropNorm,
  type ZoomFragment,
  type ZoomKeyframe,
} from "@/engine";

let version = 0;
let builtVersion = -1;

let cache = new Map<string, ZoomKeyframe[]>();
/** Fragment object identities the current `cache` entries were built from. */
let builtFragments = new Map<string, ZoomFragment>();
/** Metadata/crop references the current `cache` was built against. */
let builtMetadata: RecordingMetadata | null = null;
let builtCrop: ScreenContentCropNorm | null = null;

export function getZoomKeyframesMap(
  fragments: ZoomFragment[],
  metadata: RecordingMetadata | null,
  crop: ScreenContentCropNorm | null = null,
): Map<string, ZoomKeyframe[]> {
  if (version === builtVersion) return cache;

  // Metadata/crop feed every fragment's integration, so a changed reference for
  // either invalidates the whole cache; otherwise we can reuse per fragment.
  const canReusePrevious = metadata === builtMetadata && crop === builtCrop;
  const toContent = crop ? createFullNormToContentNdcFromCrop(crop) : undefined;

  const next = new Map<string, ZoomKeyframe[]>();
  const nextFragments = new Map<string, ZoomFragment>();

  for (const fragment of fragments) {
    const reusable =
      canReusePrevious && builtFragments.get(fragment.id) === fragment
        ? cache.get(fragment.id)
        : undefined;

    next.set(
      fragment.id,
      reusable ?? computeZoomKeyframes(fragment, metadata, undefined, toContent),
    );
    nextFragments.set(fragment.id, fragment);
  }

  cache = next;
  builtFragments = nextFragments;
  builtMetadata = metadata;
  builtCrop = crop;
  builtVersion = version;
  return cache;
}

export function invalidateZoomKeyframesCache(): void {
  version++;
}

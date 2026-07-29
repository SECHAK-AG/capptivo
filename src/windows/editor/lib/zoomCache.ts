/**
 * Zoom keyframe cache — rebuilt on invalidation, lazy per-fragment integration.
 * Editor entry point for zoom motion (handles crop mapping + composition layout).
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

/** Video rect as fractions of the composition stage (0–1). */
export type ZoomCompositionLayout = {
  video: { x: number; y: number; width: number; height: number };
};

let version = 0;
let builtVersion = -1;

let cache = new Map<string, ZoomKeyframe[]>();
/** Fragment object identities the current `cache` entries were built from. */
let builtFragments = new Map<string, ZoomFragment>();
/** Metadata/crop the current `cache` was built against. */
let builtMetadata: RecordingMetadata | null = null;
let builtCrop: ScreenContentCropNorm | null = null;
let builtLayout: ZoomCompositionLayout | null = null;
/** Content-space map for `builtCrop`; rebuilt only when the crop really moves. */
let builtToContent: ZoomContentSpaceMap | undefined;
/** Stage→recording map for fixed-rect centres; rebuilt with layout. */
let builtStageToRecording: ZoomContentSpaceMap | undefined;

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

function layoutEquals(
  a: ZoomCompositionLayout | null,
  b: ZoomCompositionLayout | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const av = a.video;
  const bv = b.video;
  return (
    av.x === bv.x &&
    av.y === bv.y &&
    av.width === bv.width &&
    av.height === bv.height
  );
}

/** Prune stale entries; does not integrate keyframes (lazy). */
function reconcile(
  fragments: ZoomFragment[],
  metadata: RecordingMetadata | null,
  crop: ScreenContentCropNorm | null,
  layout: ZoomCompositionLayout | null,
): void {
  const sameCrop = cropEquals(crop, builtCrop);
  const sameLayout = layoutEquals(layout, builtLayout);
  const sameMeta = metadata === builtMetadata;

  if (version === builtVersion && sameCrop && sameLayout && sameMeta) {
    return;
  }

  const canReuse = sameMeta && sameCrop && sameLayout;

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
  if (!sameLayout) {
    builtStageToRecording = layout
      ? (p) => ({
          x: (p.x - layout.video.x) / Math.max(1e-6, layout.video.width),
          y: (p.y - layout.video.y) / Math.max(1e-6, layout.video.height),
        })
      : undefined;
  }
  builtMetadata = metadata;
  builtCrop = crop;
  builtLayout = layout;
  builtVersion = version;
}

/** Pan/scale at `time`; neutral camera when no fragment covers `time`. */
export function getZoomPanAtTime(
  fragments: ZoomFragment[],
  metadata: RecordingMetadata | null,
  crop: ScreenContentCropNorm | null,
  time: number,
  layout: ZoomCompositionLayout | null = null,
): { x: number; y: number; scale: number } {
  reconcile(fragments, metadata, crop, layout);

  const active = findActiveZoomFragment(fragments, time);
  if (!active) return { x: 0.5, y: 0.5, scale: 1 };

  let keyframes = cache.get(active.id);
  if (!keyframes || keyframes.length === 0) {
    keyframes = computeZoomKeyframes(
      active,
      metadata,
      undefined,
      builtToContent,
      builtStageToRecording,
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

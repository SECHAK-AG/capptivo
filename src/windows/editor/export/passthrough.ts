/**
 * "Original" export eligibility — when a stream-copy of `screen.mp4` loses
 * nothing the user asked for.
 *
 * Standalone module (relative imports only) so `passthrough.selfcheck.ts` can
 * exercise the real predicate under `node --experimental-strip-types`.
 */

import { totalKeptDuration, type TrimSegment } from "../../../engine/trimSegments.ts";

/** State the check reads — a plain object so the dialog and `exportProject`
 * can both call it without sharing store wiring. */
export type PassthroughCheck = {
  segments: TrimSegment[];
  duration: number;
  zoomFragments: readonly unknown[];
  blurRegions: readonly unknown[];
  captions: readonly unknown[];
  cameraUrl: string | null;
  screenContentCrop: unknown | null;
};

/**
 * True when an "Original" (stream-copy) export loses nothing the user asked
 * for. Anything that changes pixels or drops timeline content forces the full
 * render: cuts would snap to keyframes (seconds of drift), and zooms, blurs,
 * captions, face-cam, or a content crop would silently vanish from the output.
 * Styling (padding, background, shadow) and the cursor are deliberately NOT
 * excluded — skipping them is the documented point of the option.
 */
export function isPassthroughEligible(check: PassthroughCheck): boolean {
  if (check.cameraUrl) return false;
  if (check.zoomFragments.length > 0) return false;
  if (check.blurRegions.length > 0) return false;
  if (check.captions.length > 0) return false;
  if (check.screenContentCrop != null) return false;
  if (check.segments.length > 0) {
    const kept = totalKeptDuration(check.segments);
    if (Math.abs(kept - check.duration) > 0.05) return false;
  }
  return true;
}

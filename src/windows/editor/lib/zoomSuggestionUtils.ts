/**
 * Click-cluster → zoom suggestions (seconds).
 * Explicit downs only — no dwell heuristics (Capptivo doesn't emit them).
 *
 * Improvements vs a naive 1-click=1-zoom:
 * - Merge clicks within `mergeGapSec` into one region
 * - Pad before/after; then collapse overlapping padded windows
 * - Enforce a minimum duration so single clicks still feel intentional
 */

import type { CursorClickSample } from "@/engine";

/** Landscape-ish source required for auto-apply (portrait demos stay manual). */
export const MIN_AUTO_ZOOM_SOURCE_ASPECT = 1.2;

/** Consecutive clicks closer than this join the same cluster. */
export const CLICK_CLUSTER_MERGE_GAP_SEC = 2.5;

/** Padding before the first / after the last click in a cluster. */
export const CLICK_CLUSTER_PAD_SEC = 0.5;

/** Floor so a lone click still gets a usable follow-cursor window. */
export const MIN_SUGGESTED_ZOOM_DURATION_SEC = 1.2;

/** Gentle default: readable magnification without disorienting the viewer. */
export const AUTO_ZOOM_TARGET_SCALE = 1.5;

export type SuggestedZoomSpan = {
  start: number;
  end: number;
  /** Normalized focus (strongest click); Capptivo follow-cursor uses live samples. */
  focus: { x: number; y: number };
};

export type ZoomSuggestionStatus =
  | "ok"
  | "no-duration"
  | "no-clicks"
  | "no-slots";

export type ZoomSuggestionResult = {
  status: ZoomSuggestionStatus;
  suggestions: SuggestedZoomSpan[];
};

export function shouldAutoSuggestZoomsForSource(
  sourceWidth?: number,
  sourceHeight?: number,
): boolean {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    (sourceWidth ?? 0) <= 0 ||
    (sourceHeight ?? 0) <= 0
  ) {
    return true;
  }
  return (
    (sourceWidth as number) / (sourceHeight as number) >=
    MIN_AUTO_ZOOM_SOURCE_ASPECT
  );
}

type ClickCandidate = {
  t: number;
  x: number;
  y: number;
};

function normalizeClicks(
  clicks: CursorClickSample[],
  duration: number,
): ClickCandidate[] {
  return clicks
    .filter(
      (c) =>
        Number.isFinite(c.t) &&
        Number.isFinite(c.x) &&
        Number.isFinite(c.y) &&
        c.t >= 0 &&
        c.t <= duration,
    )
    .map((c) => ({
      t: Math.max(0, Math.min(duration, c.t)),
      x: Math.max(0, Math.min(1, c.x)),
      y: Math.max(0, Math.min(1, c.y)),
    }))
    .sort((a, b) => a.t - b.t);
}

type Cluster = {
  first: number;
  last: number;
  focus: { x: number; y: number };
};

function buildClickClusters(
  clicks: ClickCandidate[],
  mergeGapSec: number,
): Cluster[] {
  if (clicks.length === 0) return [];

  const clusters: Cluster[] = [];
  let first = clicks[0]!.t;
  let last = clicks[0]!.t;
  let focus = { x: clicks[0]!.x, y: clicks[0]!.y };
  let sumX = clicks[0]!.x;
  let sumY = clicks[0]!.y;
  let count = 1;

  const flush = () => {
    clusters.push({
      first,
      last,
      focus: count > 0 ? focus : { x: sumX / count, y: sumY / count },
    });
  };

  for (let i = 1; i < clicks.length; i++) {
    const click = clicks[i]!;
    if (click.t - last <= mergeGapSec) {
      last = Math.max(last, click.t);
      // Prefer the latest click in a burst (usually the intentional one).
      focus = { x: click.x, y: click.y };
      sumX += click.x;
      sumY += click.y;
      count += 1;
    } else {
      flush();
      first = click.t;
      last = click.t;
      focus = { x: click.x, y: click.y };
      sumX = click.x;
      sumY = click.y;
      count = 1;
    }
  }
  flush();
  return clusters;
}

function spansOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.end > b.start && a.start < b.end;
}

/** Expand `[first, last]` with pad, then grow to min duration centered on the cluster. */
function windowForCluster(
  cluster: Cluster,
  duration: number,
  padSec: number,
  minDuration: number,
): { start: number; end: number } | null {
  let start = Math.max(0, cluster.first - padSec);
  let end = Math.min(duration, cluster.last + padSec);
  if (end <= start) return null;

  const len = end - start;
  if (len < minDuration) {
    const mid = (cluster.first + cluster.last) / 2;
    start = mid - minDuration / 2;
    end = mid + minDuration / 2;
    if (start < 0) {
      end = Math.min(duration, end - start);
      start = 0;
    }
    if (end > duration) {
      start = Math.max(0, start - (end - duration));
      end = duration;
    }
  }

  if (end - start < 0.05) return null;
  return { start, end };
}

/**
 * Build padded zoom windows from click clusters.
 * Existing zooms are reserved so suggestions never overlap them.
 */
export function buildClickZoomSuggestions(params: {
  clicks: CursorClickSample[];
  duration: number;
  reservedSpans?: Array<{ start: number; end: number }>;
  mergeGapSec?: number;
  padSec?: number;
  minDurationSec?: number;
}): ZoomSuggestionResult {
  const {
    clicks,
    duration,
    reservedSpans = [],
    mergeGapSec = CLICK_CLUSTER_MERGE_GAP_SEC,
    padSec = CLICK_CLUSTER_PAD_SEC,
    minDurationSec = MIN_SUGGESTED_ZOOM_DURATION_SEC,
  } = params;

  if (!(duration > 0)) {
    return { status: "no-duration", suggestions: [] };
  }

  const normalized = normalizeClicks(clicks, duration);
  if (normalized.length === 0) {
    return { status: "no-clicks", suggestions: [] };
  }

  const clusters = buildClickClusters(normalized, mergeGapSec);
  const reserved = reservedSpans
    .filter((s) => s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start);

  const raw: SuggestedZoomSpan[] = [];

  for (const cluster of clusters) {
    const win = windowForCluster(cluster, duration, padSec, minDurationSec);
    if (!win) continue;
    if (reserved.some((span) => spansOverlap(win, span))) continue;
    reserved.push(win);
    raw.push({ start: win.start, end: win.end, focus: cluster.focus });
  }

  if (raw.length === 0) {
    return { status: "no-slots", suggestions: [] };
  }

  // Collapse any residual overlaps (min-duration expansion can bump neighbors).
  raw.sort((a, b) => a.start - b.start);
  const merged: SuggestedZoomSpan[] = [];
  for (const span of raw) {
    const prev = merged[merged.length - 1];
    if (prev && spansOverlap(prev, span)) {
      prev.end = Math.max(prev.end, span.end);
      prev.focus = span.focus;
    } else {
      merged.push({ ...span, focus: { ...span.focus } });
    }
  }

  return { status: "ok", suggestions: merged };
}

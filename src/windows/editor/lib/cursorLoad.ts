/** Load `cursor.json` via media:// and map it to the engine's RecordingMetadata. */

import {
  CURSOR_SHAPE_IDS,
  type CursorPressInterval,
  type CursorShapeId,
  type RecordingMetadata,
} from "@/engine";
import { mediaUrl } from "@/lib/platform";

type CursorTrackJson = {
  samples?: Array<{ t: number; x: number; y: number; kind?: string; shape?: string }>;
  captureRect?: { width?: number; height?: number };
};

function parseShape(raw: string | undefined): CursorShapeId | undefined {
  return CURSOR_SHAPE_IDS.includes(raw as CursorShapeId) ? (raw as CursorShapeId) : undefined;
}

/** Pair down→up samples into hold windows; an unclosed hold runs to the end. */
function buildPressIntervals(
  samples: Array<{ t: number; kind?: string }>,
): CursorPressInterval[] {
  const intervals: CursorPressInterval[] = [];
  for (const s of samples) {
    const t = Number(s.t) || 0;
    if (s.kind === "down") {
      intervals.push({ start: t, end: Number.POSITIVE_INFINITY });
    } else if (s.kind === "up" && intervals.length > 0) {
      const open = intervals[intervals.length - 1];
      if (!Number.isFinite(open.end)) open.end = t;
    }
  }
  return intervals;
}

/**
 * Shape runs shorter than this are treated as sensor glitches, not real
 * hovers. `NSCursor.currentSystemCursor` occasionally reports one-probe
 * transients (hand / closed-hand during clicks); replaying them crossfades
 * the cursor there and back — visible flicker. New recordings are debounced
 * at capture time (see cursor/mod.rs ShapeDebouncer); this filter repairs
 * tracks recorded before that fix.
 */
const MIN_SHAPE_RUN_S = 0.16;

/** `shape` may be undefined — tracks omit the default shape to stay lean. */
type LoadedCursorSample = {
  t: number;
  x: number;
  y: number;
  shape: CursorShapeId | undefined;
};

function suppressShapeBlips(samples: LoadedCursorSample[]): LoadedCursorSample[] {
  if (samples.length < 3) return samples;

  // Indices where a new shape run begins.
  const runStarts: number[] = [0];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].shape !== samples[i - 1].shape) runStarts.push(i);
  }
  if (runStarts.length < 3) return samples;

  // Collapse A→B→A blips: a short middle run flanked by the same shape.
  for (let r = 1; r < runStarts.length - 1; r++) {
    const start = runStarts[r];
    const next = runStarts[r + 1];
    const duration = samples[next].t - samples[start].t;
    const before = samples[runStarts[r] - 1].shape;
    const after = samples[next].shape;
    if (duration < MIN_SHAPE_RUN_S && before === after) {
      for (let i = start; i < next; i++) samples[i].shape = before;
    }
  }
  return samples;
}

export async function loadRecordingMetadata(
  projectId: string,
  sourceSize: { width: number; height: number } | null,
): Promise<RecordingMetadata | null> {
  try {
    const res = await fetch(mediaUrl(projectId, "cursor.json"));
    if (!res.ok) return null;
    const data = (await res.json()) as CursorTrackJson;
    const samples = Array.isArray(data.samples) ? data.samples : [];
    if (samples.length === 0) return null;

    return {
      schemaVersion: 2,
      sourceWidth: sourceSize?.width ?? data.captureRect?.width ?? 1920,
      sourceHeight: sourceSize?.height ?? data.captureRect?.height ?? 1080,
      cursorSamples: suppressShapeBlips(
        samples.map((s) => ({
          t: Number(s.t) || 0,
          x: Number(s.x) || 0,
          y: Number(s.y) || 0,
          shape: parseShape(s.shape),
        })),
      ),
      cursorClickSamples: samples
        .filter((s) => s.kind === "down")
        .map((s) => ({
          t: Number(s.t) || 0,
          x: Number(s.x) || 0,
          y: Number(s.y) || 0,
        })),
      cursorPressIntervals: buildPressIntervals(samples),
    };
  } catch {
    return null;
  }
}

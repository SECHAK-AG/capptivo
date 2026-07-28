export type TrimSegment = {
  id: string;
  start: number;
  end: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createSegmentId(): string {
  return `seg-${Math.random().toString(36).slice(2, 10)}`;
}

export function createFullSegment(duration: number): TrimSegment[] {
  const safeDuration = Math.max(0, duration);
  if (safeDuration <= 0) return [];
  return [{ id: createSegmentId(), start: 0, end: safeDuration }];
}

export function normalizeSegments(
  segments: TrimSegment[],
  duration: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  minLength: number,
): TrimSegment[] {
  const safeDuration = Math.max(0, duration);
  if (safeDuration <= 0) return [];

  const sorted = [...segments]
    .map((s) => ({
      ...s,
      start: clamp(s.start, 0, safeDuration),
      end: clamp(s.end, 0, safeDuration),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: TrimSegment[] = [];
  for (const seg of sorted) {
    if (out.length === 0) {
      out.push(seg);
      continue;
    }

    const prev = out[out.length - 1];
    if (seg.start < prev.end) {
      prev.end = Math.max(prev.end, seg.end);
      continue;
    }

    out.push(seg);
  }

  return out.filter((s) => s.end > s.start);
}

export function totalKeptDuration(segments: TrimSegment[]): number {
  return segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
}

export function findSegmentIndexAtTime(
  segments: TrimSegment[],
  time: number,
): number {
  return segments.findIndex((s) => time >= s.start && time <= s.end);
}

export function snapTimeToKeptRange(
  segments: TrimSegment[],
  time: number,
): number {
  if (segments.length === 0) return 0;

  if (time <= segments[0].start) return segments[0].start;
  const last = segments[segments.length - 1];
  if (time >= last.end) return last.end;

  const inside = findSegmentIndexAtTime(segments, time);
  if (inside >= 0) return time;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const a = segments[i];
    const b = segments[i + 1];
    if (time > a.end && time < b.start) {
      return time - a.end <= b.start - time ? a.end : b.start;
    }
  }

  return time;
}

export function getNextPlayableTime(
  segments: TrimSegment[],
  time: number,
): number | null {
  if (segments.length === 0) return null;

  for (const seg of segments) {
    if (time < seg.start) return seg.start;
    if (time >= seg.start && time < seg.end) return time;
  }

  return null;
}

export function moveSegmentEdge(
  segments: TrimSegment[],
  id: string,
  edge: "start" | "end",
  value: number,
  duration: number,
  minLength: number,
): TrimSegment[] {
  const safeDuration = Math.max(0, duration);
  const safeMin = Math.max(0, minLength);

  const sorted = normalizeSegments(segments, safeDuration, minLength);
  const idx = sorted.findIndex((s) => s.id === id);
  if (idx < 0) return sorted;

  const seg = sorted[idx]!;
  const prev = idx > 0 ? sorted[idx - 1]! : null;
  const next = idx < sorted.length - 1 ? sorted[idx + 1]! : null;

  const trimGapBefore =
    (prev !== null && prev.end < seg.start) ||
    (prev === null && seg.start > 0);
  const trimGapAfter =
    (next !== null && seg.end < next.start) ||
    (next === null && seg.end < safeDuration);

  const minKept = trimGapBefore && trimGapAfter ? 0 : safeMin;

  const nextList = sorted.map((s) => {
    if (s.id !== id) return s;

    if (edge === "start") {
      const newStart = clamp(value, 0, seg.end - minKept);
      return { ...s, start: newStart };
    }

    const newEnd = clamp(value, seg.start + minKept, safeDuration);
    return { ...s, end: newEnd };
  });

  return normalizeSegments(nextList, safeDuration, minLength);
}

export function splitSegmentAtTime(
  segments: TrimSegment[],
  time: number,
  minLength: number,
): TrimSegment[] {
  const safeMin = Math.max(0, minLength);
  const idx = findSegmentIndexAtTime(segments, time);
  if (idx < 0) return segments;

  const seg = segments[idx];
  if (time <= seg.start + safeMin || time >= seg.end - safeMin) return segments;

  const left: TrimSegment = {
    id: createSegmentId(),
    start: seg.start,
    end: time,
  };
  const right: TrimSegment = {
    id: createSegmentId(),
    start: time,
    end: seg.end,
  };

  return [...segments.slice(0, idx), left, right, ...segments.slice(idx + 1)];
}

export function addSegmentNearTime(
  segments: TrimSegment[],
  time: number,
  duration: number,
  minLength: number,
): TrimSegment[] {
  const safeDuration = Math.max(0, duration);
  const safeMin = Math.max(0.1, minLength);
  if (safeDuration <= 0) return segments;

  const sorted = normalizeSegments(segments, safeDuration, minLength);
  const candidateLength = Math.min(Math.max(1.5, safeMin * 3), safeDuration);
  const half = candidateLength / 2;
  let start = clamp(time - half, 0, safeDuration - safeMin);
  let end = clamp(start + candidateLength, start + safeMin, safeDuration);

  for (let i = 0; i <= sorted.length; i += 1) {
    const prevEnd = i === 0 ? 0 : sorted[i - 1].end;
    const nextStart = i === sorted.length ? safeDuration : sorted[i].start;

    if (end <= prevEnd || start >= nextStart) {
      continue;
    }

    const gapStart = prevEnd;
    const gapEnd = nextStart;
    const gap = gapEnd - gapStart;
    if (gap < safeMin) continue;

    const centeredStart = clamp(
      time - candidateLength / 2,
      gapStart,
      Math.max(gapStart, gapEnd - safeMin),
    );
    const centeredEnd = clamp(
      centeredStart + candidateLength,
      centeredStart + safeMin,
      gapEnd,
    );

    start = centeredStart;
    end = centeredEnd;
    break;
  }

  if (end - start < safeMin) {
    for (let i = 0; i <= sorted.length; i += 1) {
      const gapStart = i === 0 ? 0 : sorted[i - 1].end;
      const gapEnd = i === sorted.length ? safeDuration : sorted[i].start;
      if (gapEnd - gapStart >= safeMin) {
        start = gapStart;
        end = Math.min(gapEnd, gapStart + candidateLength);
        break;
      }
    }
  }

  if (end - start < safeMin) return sorted;

  return normalizeSegments(
    [...sorted, { id: createSegmentId(), start, end }],
    safeDuration,
    minLength,
  );
}

export function removeSegmentById(
  segments: TrimSegment[],
  id: string,
): TrimSegment[] {
  return segments.filter((s) => s.id !== id);
}

export type SubtractRangeOptions = {
  boundaryBridgeMin?: number;
};

export function subtractRangeFromSegments(
  segments: TrimSegment[],
  rangeStart: number,
  rangeEnd: number,
  duration: number,
  minLength: number,
  options?: SubtractRangeOptions,
): TrimSegment[] {
  const safeDuration = Math.max(0, duration);
  const bridge =
    options?.boundaryBridgeMin !== undefined
      ? Math.max(0, options.boundaryBridgeMin)
      : Math.max(0, minLength);
  if (safeDuration <= 0) return [];

  const cutStart = clamp(Math.min(rangeStart, rangeEnd), 0, safeDuration);
  const cutEnd = clamp(Math.max(rangeStart, rangeEnd), 0, safeDuration);
  if (!(cutEnd > cutStart)) {
    return normalizeSegments(segments, safeDuration, minLength);
  }

  const normalized = normalizeSegments(segments, safeDuration, minLength);
  const next: TrimSegment[] = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const seg = normalized[i]!;

    if (seg.end <= cutStart || seg.start >= cutEnd) {
      next.push(seg);
      continue;
    }

    let holeStart = Math.max(seg.start, cutStart);
    let holeEnd = Math.min(seg.end, cutEnd);

    if (!(holeEnd > holeStart)) {
      next.push(seg);
      continue;
    }

    const prev = i > 0 ? normalized[i - 1]! : null;
    const nextSeg = i < normalized.length - 1 ? normalized[i + 1]! : null;

    const trimGapBefore =
      (prev !== null && prev.end < seg.start) ||
      (prev === null && seg.start > 0);
    const trimGapAfter =
      (nextSeg !== null && seg.end < nextSeg.start) ||
      (nextSeg === null && seg.end < safeDuration);

    if (bridge > 0 && seg.end - seg.start > bridge) {
      if (trimGapBefore && holeStart < seg.start + bridge) {
        holeStart = seg.start + bridge;
      }

      if (trimGapAfter && holeEnd > seg.end - bridge) {
        holeEnd = seg.end - bridge;
      }
    }

    if (!(holeEnd > holeStart)) {
      next.push(seg);
      continue;
    }

    const leftStart = seg.start;
    const leftEnd = holeStart;

    if (leftEnd > leftStart) {
      next.push({ id: createSegmentId(), start: leftStart, end: leftEnd });
    }

    const rightStart = holeEnd;
    const rightEnd = seg.end;

    if (rightEnd > rightStart) {
      next.push({ id: createSegmentId(), start: rightStart, end: rightEnd });
    }
  }

  return normalizeSegments(next, safeDuration, minLength);
}

/** Trim holes (removed ranges) between kept segments on the source timeline. */
export function computeTrimGaps(
  segments: TrimSegment[],
  duration: number,
): Array<{ start: number; end: number }> {
  const safeDuration = Math.max(0, duration);
  if (safeDuration <= 0) return [];

  const normalized = normalizeSegments(segments, safeDuration, 0);
  if (normalized.length === 0) return [{ start: 0, end: safeDuration }];

  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const seg of normalized) {
    if (seg.start > cursor) gaps.push({ start: cursor, end: seg.start });
    cursor = seg.end;
  }
  if (cursor < safeDuration) gaps.push({ start: cursor, end: safeDuration });
  return gaps;
}

/** Rebuild kept segments from trim gaps (inverse of {@link computeTrimGaps}). */
export function segmentsFromTrimGaps(
  gaps: Array<{ start: number; end: number }>,
  duration: number,
): TrimSegment[] {
  const safeDuration = Math.max(0, duration);
  if (safeDuration <= 0) return [];

  const sorted = [...gaps]
    .filter((g) => g.end > g.start + 1e-9)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const kept: TrimSegment[] = [];
  let cursor = 0;
  for (const gap of sorted) {
    const gapStart = clamp(gap.start, 0, safeDuration);
    const gapEnd = clamp(gap.end, 0, safeDuration);
    if (gapStart > cursor + 1e-9) {
      kept.push({ id: createSegmentId(), start: cursor, end: gapStart });
    }
    cursor = Math.max(cursor, gapEnd);
  }
  if (cursor < safeDuration - 1e-9) {
    kept.push({ id: createSegmentId(), start: cursor, end: safeDuration });
  }
  return normalizeSegments(kept, safeDuration, 0);
}

const MIN_TRIM_GAP_SPAN = 1e-3;

function normalizeTrimGapList(
  gaps: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = [...gaps]
    .filter((g) => g.end > g.start + MIN_TRIM_GAP_SPAN)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const gap of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...gap });
      continue;
    }
    if (gap.start <= prev.end + 1e-6) {
      prev.end = Math.max(prev.end, gap.end);
      continue;
    }
    merged.push({ ...gap });
  }
  return merged;
}

/** Union a new cut into existing trim gaps. */
export function mergeTimeRangeIntoTrimGaps(
  gaps: Array<{ start: number; end: number }>,
  cutStart: number,
  cutEnd: number,
): Array<{ start: number; end: number }> {
  const range = {
    start: Math.min(cutStart, cutEnd),
    end: Math.max(cutStart, cutEnd),
  };
  if (!(range.end > range.start + MIN_TRIM_GAP_SPAN)) {
    return normalizeTrimGapList(gaps);
  }

  const next: Array<{ start: number; end: number }> = [];
  let mergedRange: { start: number; end: number } | null = null;

  for (const gap of [...gaps].sort((a, b) => a.start - b.start)) {
    if (gap.end < range.start || gap.start > range.end) {
      next.push(gap);
      continue;
    }
    if (!mergedRange) {
      mergedRange = {
        start: Math.min(range.start, gap.start),
        end: Math.max(range.end, gap.end),
      };
      continue;
    }
    mergedRange.start = Math.min(mergedRange.start, gap.start);
    mergedRange.end = Math.max(mergedRange.end, gap.end);
  }

  next.push(mergedRange ?? { ...range });
  return normalizeTrimGapList(next);
}

/** Cut `[cutStart, cutEnd]` out of the kept segments (add a trim gap). */
export function addTrimGap(
  segments: TrimSegment[],
  cutStart: number,
  cutEnd: number,
  duration: number,
): TrimSegment[] {
  const safeDuration = Math.max(0, duration);
  const start = clamp(Math.min(cutStart, cutEnd), 0, safeDuration);
  const end = clamp(Math.max(cutStart, cutEnd), 0, safeDuration);
  if (!(end > start + MIN_TRIM_GAP_SPAN)) {
    return normalizeSegments(segments, safeDuration, 0);
  }
  const gaps = computeTrimGaps(segments, safeDuration);
  return segmentsFromTrimGaps(
    mergeTimeRangeIntoTrimGaps(gaps, start, end),
    safeDuration,
  );
}

export function resizeTrimGapAtIndex(
  segments: TrimSegment[],
  gapIndex: number,
  edge: "start" | "end",
  time: number,
  duration: number,
): TrimSegment[] {
  const safeDuration = Math.max(0, duration);
  const gaps = computeTrimGaps(segments, safeDuration);
  const gap = gaps[gapIndex];
  if (!gap) return normalizeSegments(segments, safeDuration, 0);

  const nextGaps = gaps.map((current, i) => {
    if (i !== gapIndex) return current;
    if (edge === "start") {
      return {
        start: clamp(time, 0, current.end - MIN_TRIM_GAP_SPAN),
        end: current.end,
      };
    }
    return {
      start: current.start,
      end: clamp(time, current.start + MIN_TRIM_GAP_SPAN, safeDuration),
    };
  });
  return segmentsFromTrimGaps(nextGaps, safeDuration);
}

/**
 * Adaptive timeline ruler — nice major/minor steps from pixels-per-second
 * so labels stay readable at any zoom (Filmora / Premiere style).
 */

/** Format a timeline clock. Whole seconds by default; pass `decimals` when zoomed in. */
export function formatTimelineTime(seconds: number, decimals = 0): string {
  const abs = Math.max(0, seconds);
  const factor = 10 ** Math.max(0, decimals);
  const total = Math.round(abs * factor) / factor;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const sStr =
    decimals > 0
      ? s.toFixed(decimals).padStart(3 + decimals, "0")
      : String(Math.floor(s)).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${sStr}`;
  return `${String(m).padStart(2, "0")}:${sStr}`;
}

/** Nice major intervals (seconds) — 1-2-5 style, plus common media steps. */
const RULER_MAJOR_STEPS = [
  0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
] as const;

/** Minimum px between labeled majors so `mm:ss` stays readable. */
const MIN_MAJOR_LABEL_PX = 72;
/** Minimum px between unlabeled minor ticks. */
const MIN_MINOR_TICK_PX = 10;

export type TimelineRulerTick = {
  time: number;
  major: boolean;
  /** Present only on major ticks. */
  label?: string;
};

/**
 * Pick a nice major step from pixels-per-second so labels never collide,
 * then subdivide with minors when there is room.
 */
export function buildTimelineRuler(
  duration: number,
  pixelsPerSecond: number,
): TimelineRulerTick[] {
  if (!(duration > 0) || !(pixelsPerSecond > 0)) {
    return [{ time: 0, major: true, label: formatTimelineTime(0) }];
  }

  const minMajorSec = MIN_MAJOR_LABEL_PX / pixelsPerSecond;
  const majorStep =
    RULER_MAJOR_STEPS.find((s) => s >= minMajorSec) ??
    RULER_MAJOR_STEPS[RULER_MAJOR_STEPS.length - 1]!;

  const decimals = majorStep < 0.1 ? 2 : majorStep < 1 ? 1 : 0;

  // Widen from RULER_MAJOR_STEPS' literal-union type: subdivisions below are
  // arbitrary fractions.
  let minorStep: number = majorStep;
  for (const div of [10, 5, 4, 2] as const) {
    const candidate = majorStep / div;
    if (candidate * pixelsPerSecond >= MIN_MINOR_TICK_PX) {
      minorStep = candidate;
      break;
    }
  }

  const majorsPerMinor = Math.max(1, Math.round(majorStep / minorStep));
  const count = Math.floor(duration / minorStep + 1e-9);
  const ticks: TimelineRulerTick[] = [];

  for (let i = 0; i <= count; i++) {
    const time = Math.round(i * minorStep * 1e6) / 1e6;
    if (time > duration + 1e-6) break;
    const major = i % majorsPerMinor === 0;
    ticks.push(
      major
        ? { time, major: true, label: formatTimelineTime(time, decimals) }
        : { time, major: false },
    );
  }

  return ticks;
}

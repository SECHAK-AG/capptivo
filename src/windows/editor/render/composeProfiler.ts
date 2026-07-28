/**
 * Per-phase timing inside `compose()`.
 *
 * "The export is slow" is not actionable; "the render call is 35 ms and
 * everything else is 2 ms" is. Each compositor marks its phases, and the export
 * loop dumps the averages when it finishes, so a slow export can be attributed
 * rather than guessed at.
 *
 * Off by default. `performance.now()` is cheap but not free, and the preview
 * calls `compose()` sixty times a second for as long as the editor is open.
 */

export class ComposeProfiler {
  private readonly totals = new Map<string, number>();
  private frames = 0;
  private last = 0;

  constructor(readonly enabled: boolean) {}

  /** Start a frame. */
  begin(): void {
    if (!this.enabled) return;
    this.frames += 1;
    this.last = performance.now();
  }

  /** Attribute the time since the previous mark (or `begin`) to `phase`. */
  mark(phase: string): void {
    if (!this.enabled) return;
    const now = performance.now();
    this.totals.set(phase, (this.totals.get(phase) ?? 0) + (now - this.last));
    this.last = now;
  }

  /** Per-frame averages, slowest phase first. Null when nothing was measured. */
  report(): string | null {
    if (!this.enabled || this.frames === 0) return null;
    const rows = [...this.totals.entries()]
      .map(([phase, total]) => ({ phase, ms: total / this.frames }))
      .sort((a, b) => b.ms - a.ms);
    const sum = rows.reduce((acc, r) => acc + r.ms, 0);
    return (
      `${sum.toFixed(1)}ms/frame — ` +
      rows.map((r) => `${r.phase} ${r.ms.toFixed(1)}`).join(", ")
    );
  }

  reset(): void {
    this.totals.clear();
    this.frames = 0;
  }
}

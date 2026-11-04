/** Project a pointer's stage-space movement onto the recording corner diagonal.
 * A fixed start snapshot avoids compounding scale on every pointer event.
 */
export function recordingScaleFromDrag(startScale: number, vx: number, vy: number, dx: number, dy: number): number {
  if (![startScale, vx, vy, dx, dy].every(Number.isFinite)) return 1;
  const ratio = 1 + (dx * vx + dy * vy) / Math.max(1, vx * vx + vy * vy);
  return Math.max(0.5, Math.min(3, startScale * ratio));
}

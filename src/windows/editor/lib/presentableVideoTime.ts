/**
 * Exact t=0 often paints a blank frame in WKWebView (videoWidth is set, but
 * drawImage / texture upload stays black). Park one ms later for presentation.
 * UI/store may still show 0 — this is only for `<video>.currentTime`.
 */
export const FIRST_PRESENTABLE_TIME = 0.001;

export function presentableVideoTime(t: number, duration: number): number {
  if (!(duration > 0) || !Number.isFinite(t)) return t;
  const eps = FIRST_PRESENTABLE_TIME;
  if (t >= eps) return Math.min(t, Math.max(0, duration - eps));
  return Math.min(eps, Math.max(0, duration - eps));
}

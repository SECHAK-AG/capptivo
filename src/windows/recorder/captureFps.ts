/**
 * Capture frame rate — the setting that decides whether a 60 fps *export* can
 * ever be real.
 *
 * Nothing downstream can invent frames the recorder never captured: exporting a
 * 30 fps take at 60 duplicates every screen frame, doubling encode work for
 * motion that is still 30 fps. Real 60 has to start here.
 *
 * Every capture backend already clamps and honours `RecorderConfig.fps`
 * (`wgc_backend`, `scap_backend`, `portal_backend`), and `FramePacer` writes the
 * chosen rate into `meta.json`, so this is a straight passthrough — the value
 * just had no UI.
 */

export type CaptureFps = 30 | 60;

export const CAPTURE_FPS_OPTIONS: readonly CaptureFps[] = [30, 60];

/**
 * 30 stays the default: it is half the encode work, half the disk, and enough
 * for the screen-recording-with-zoom footage Capptivo is built around.
 */
export const DEFAULT_CAPTURE_FPS: CaptureFps = 30;

export const CAPTURE_FPS_STORAGE_KEY = "capptivo.capture.fps";

export function isCaptureFps(value: unknown): value is CaptureFps {
  return value === 30 || value === 60;
}

/** Parse a persisted value, falling back rather than throwing on anything odd. */
export function parseCaptureFps(raw: string | null): CaptureFps {
  const n = Number(raw);
  return isCaptureFps(n) ? n : DEFAULT_CAPTURE_FPS;
}

export function getStoredCaptureFps(): CaptureFps {
  try {
    return parseCaptureFps(localStorage.getItem(CAPTURE_FPS_STORAGE_KEY));
  } catch {
    return DEFAULT_CAPTURE_FPS;
  }
}

export function storeCaptureFps(fps: CaptureFps): void {
  try {
    localStorage.setItem(CAPTURE_FPS_STORAGE_KEY, String(fps));
  } catch {
    /* storage may be unavailable (private mode) — preference is best-effort */
  }
}

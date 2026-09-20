export interface RecorderErrorNotice {
  message: string;
  fatal: boolean;
}

export type RecorderHudLayout = "hud" | "hud-mini" | "hud-notice";

export const NON_FATAL_ERROR_DISMISS_MS = 6000;

export function nextRecorderError(
  previous: RecorderErrorNotice | null,
  next: RecorderErrorNotice,
): RecorderErrorNotice {
  return previous?.fatal && !next.fatal ? previous : next;
}

export function recorderErrorAfterLiveEnd(
  error: RecorderErrorNotice | null,
): RecorderErrorNotice | null {
  return error?.fatal ? error : null;
}

export function recorderLiveNotice(
  error: RecorderErrorNotice | null,
): RecorderErrorNotice | null {
  return error && !error.fatal && error.message.trim() ? error : null;
}

export function recorderHudLayout(
  error: RecorderErrorNotice | null,
  collapsed: boolean,
  live: boolean,
): RecorderHudLayout | null {
  if (!live) return null;
  if (error && !error.fatal) return "hud-notice";
  return collapsed ? "hud-mini" : "hud";
}

/** Fatal recorder failures stay visible until the recorder owner dismisses them */
export function recorderErrorDismissDelay(
  error: RecorderErrorNotice,
): number | null {
  return error.fatal ? null : NON_FATAL_ERROR_DISMISS_MS;
}

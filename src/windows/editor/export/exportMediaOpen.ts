/**
 * Export media open helpers — sequential decode with lazy seekable migration.
 */

import { commands } from "../../../ipc/bindings";
import { type FaceCamTrack } from "../lib/faceCamSync";
import { exportLog } from "./exportLog";
import { openSequentialMedia, type SequentialMedia } from "./sequentialMedia";

/**
 * Open sequential decode, retrying once after migrating fMP4 → progressive when
 * the first open fails. Skips `ensureSeekableRecording` on the happy path so
 * modern recordings never pay a blocking Rust round-trip before render starts.
 */
export async function openExportSequentialMedia(
  screenUrl: string,
  faceCam: FaceCamTrack,
  route: string,
  projectId: string,
): Promise<SequentialMedia | null> {
  const first = await openSequentialMedia(screenUrl, faceCam, route);
  if (first) return first;

  exportLog(
    `[export] sequential decode unavailable for ${route}; ensuring seekable recording and retrying…`,
  );
  const t0 = performance.now();
  await commands.ensureSeekableRecording(projectId);
  exportLog(
    `[export] ensureSeekableRecording done in ${(performance.now() - t0).toFixed(0)}ms (retry)`,
  );
  return openSequentialMedia(screenUrl, faceCam, route);
}

/** Ensure progressive MP4 before the seek fallback (fragmented sources freeze seeks). */
export async function ensureSeekableForSeekPath(
  projectId: string,
): Promise<void> {
  exportLog(`[export] ensureSeekableRecording(${projectId})… (seek path)`);
  const t0 = performance.now();
  await commands.ensureSeekableRecording(projectId);
  exportLog(
    `[export] ensureSeekableRecording done in ${(performance.now() - t0).toFixed(0)}ms`,
  );
}

/**
 * Console + rolling disk log (`capptivo.log`). Export timings and route
 * choices are the first thing a slow-export report needs — keeping them only
 * in devtools made "export is slow" undiagnosable outside a dev session.
 */

import { logClientInfo } from "@/lib/errorLogging";

export function exportLog(message: string): void {
  console.info(message);
  logClientInfo("export", message);
}

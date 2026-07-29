/**
 * Cooperative cancel for the in-flight export. One AbortController at a time —
 * the progress overlay calls {@link cancelActiveExport}; the frame loops check
 * the signal at yield-friendly points so cancel lands within ~one frame.
 */

export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelledError";
  }
}

let active: AbortController | null = null;

/** Start a new export session; returns the signal the loops must honor. */
export function beginExportAbort(): AbortSignal {
  active?.abort();
  active = new AbortController();
  return active.signal;
}

/** User Cancel — no-op if nothing is exporting. */
export function cancelActiveExport(): void {
  active?.abort();
}

/** Drop the session handle once the export try/finally finishes. */
export function endExportAbort(): void {
  active = null;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelledError();
}

export function isExportCancelled(error: unknown): boolean {
  return error instanceof ExportCancelledError;
}

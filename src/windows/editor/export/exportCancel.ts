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

let active: { id: number; controller: AbortController } | null = null;
let nextId = 1;

export type ExportAbortSession = {
  id: number;
  signal: AbortSignal;
};

/** Start a new export session; returns the signal the loops must honor. */
export function beginExportAbort(): ExportAbortSession {
  active?.controller.abort();
  const controller = new AbortController();
  const session = { id: nextId++, controller };
  active = session;
  return { id: session.id, signal: controller.signal };
}

/** User Cancel — no-op if nothing is exporting. */
export function cancelActiveExport(): void {
  active?.controller.abort();
}

/** Drop the session handle once the export try/finally finishes. */
export function endExportAbort(id: number): void {
  if (active?.id === id) active = null;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExportCancelledError();
}

export function isExportCancelled(error: unknown): boolean {
  return error instanceof ExportCancelledError;
}

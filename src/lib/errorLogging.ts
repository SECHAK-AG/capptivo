/**
 * Persist JS errors to the on-disk error log (Rust `logs/errors.log`).
 * Errors only — never info/warn.
 */

import { commands } from "../ipc/bindings";

function describe(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const err = e as { kind?: unknown; message?: unknown };
    if (typeof err.message === "string" && err.message.length > 0) {
      return err.message;
    }
    if (typeof err.kind === "string") return err.kind;
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

let installed = false;

/** Fire-and-forget append; never throws into UI. */
export function logClientError(source: string, error: unknown): void {
  const message = describe(error);
  if (!message) return;
  void commands.logClientError(source, message).catch(() => undefined);
}

/** Install once per webview: uncaught errors + rejected promises. */
export function installErrorLogging(windowLabel: string): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    const parts = [
      event.message,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "",
      event.error instanceof Error ? event.error.stack : "",
    ].filter(Boolean);
    logClientError(`${windowLabel}:uncaught`, parts.join(" | "));
  });

  window.addEventListener("unhandledrejection", (event) => {
    logClientError(`${windowLabel}:unhandledrejection`, event.reason);
  });
}

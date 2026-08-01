/** Production file log via Rust `log_js` → same `capptivo.YYYY-MM-DD.log`. */

import { commands } from "@/ipc/bindings";

export function logError(message: string): void {
  void commands.logJs("error", message).catch(() => undefined);
}

export function logWarn(message: string): void {
  void commands.logJs("warn", message).catch(() => undefined);
}

/** Install once per webview — uncaught errors land in the log file. */
export function installProductionErrorLogging(): void {
  window.addEventListener("error", (e) => {
    logError(
      `uncaught: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const text =
      r instanceof Error
        ? (r.stack ?? r.message)
        : typeof r === "string"
          ? r
          : JSON.stringify(r);
    logError(`unhandledrejection: ${text}`);
  });
}

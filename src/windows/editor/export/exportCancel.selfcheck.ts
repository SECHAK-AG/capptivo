/** Selfcheck: export cancel helpers. */
import {
  ExportCancelledError,
  beginExportAbort,
  cancelActiveExport,
  endExportAbort,
  isExportCancelled,
  throwIfAborted,
} from "./exportCancel.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const signal = beginExportAbort();
assert(!signal.aborted, "fresh signal is not aborted");
throwIfAborted(signal); // must not throw

cancelActiveExport();
assert(signal.aborted, "cancel aborts the active signal");
try {
  throwIfAborted(signal);
  throw new Error("expected throwIfAborted to throw");
} catch (e) {
  assert(isExportCancelled(e), "abort throws ExportCancelledError");
  assert(e instanceof ExportCancelledError, "instanceof ExportCancelledError");
}

endExportAbort();
cancelActiveExport(); // no-op after end

console.log("exportCancel.selfcheck: ok");

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

const first = beginExportAbort();
const signal = first.signal;
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

const second = beginExportAbort();
assert(signal.aborted, "starting a new export aborts the old signal");
endExportAbort(first.id);
assert(!second.signal.aborted, "old export cannot clear the new active session");
cancelActiveExport();
assert(second.signal.aborted, "active export remains cancellable");
endExportAbort(second.id);
cancelActiveExport(); // no-op after end

console.log("exportCancel.selfcheck: ok");

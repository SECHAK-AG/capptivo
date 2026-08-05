/** Selfcheck: export stall detection (pure). */

import {
  ASYNC_READBACK_FALLBACK_MS,
  ENCODE_STALL_MS,
  ExportStallError,
  StallWatchdog,
  isExportStallError,
  withDeadline,
} from "./exportStall.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(
  ASYNC_READBACK_FALLBACK_MS < ENCODE_STALL_MS,
  "async readback must fall back to sync before the route-killing stall fires",
);

// A token that keeps rising is healthy no matter how long the loop runs.
{
  const watchdog = new StallWatchdog("test", ENCODE_STALL_MS, 0);
  for (let i = 1; i <= 100; i++) {
    watchdog.check(i, i * ENCODE_STALL_MS * 2);
  }
}

// A flat token throws once — and only once — the window has fully elapsed.
{
  const watchdog = new StallWatchdog("test", 1000, 0);
  watchdog.check(7, 0);
  watchdog.check(7, 999);
  let threw = false;
  try {
    watchdog.check(7, 1000);
  } catch (e) {
    threw = true;
    assert(isExportStallError(e), "a stall raises ExportStallError");
    assert(
      (e as Error).message.includes("test"),
      "the message names the watched stage",
    );
  }
  assert(threw, "a flat token past the window must throw");
}

// Progress after a near-stall resets the clock rather than merely delaying it.
{
  const watchdog = new StallWatchdog("test", 1000, 0);
  watchdog.check(1, 0);
  watchdog.check(1, 900);
  watchdog.check(2, 950); // progress
  watchdog.check(2, 1900); // only 950ms since progress — still fine
}

assert(
  !isExportStallError(new Error("plain")),
  "an unrelated error is not a stall",
);
assert(
  isExportStallError(new ExportStallError("where", 1)),
  "ExportStallError is recognised",
);

const results: string[] = [];

await withDeadline(Promise.resolve("ok"), 1000, "fast")
  .then((v) => results.push(`resolved:${v}`))
  .catch(() => results.push("resolved:unexpected-reject"));

// A promise that never settles must reject on the deadline, not hang the suite.
await withDeadline(new Promise(() => {}), 20, "never")
  .then(() => results.push("hang:unexpected-resolve"))
  .catch((e) =>
    results.push(isExportStallError(e) ? "hang:stalled" : "hang:wrong-error"),
  );

// An underlying rejection wins over the deadline and keeps its own error.
await withDeadline(Promise.reject(new Error("boom")), 1000, "rejects")
  .then(() => results.push("reject:unexpected-resolve"))
  .catch((e) =>
    results.push(
      (e as Error).message === "boom" ? "reject:original" : "reject:wrong",
    ),
  );

assert(
  results.join("|") === "resolved:ok|hang:stalled|reject:original",
  `withDeadline behaved unexpectedly: ${results.join("|")}`,
);

console.log("exportStall.selfcheck: ok");

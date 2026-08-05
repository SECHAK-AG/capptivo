/** Selfcheck: updater status kind tags stay camelCase for the JS listener. */

const kinds = [
  "checking",
  "upToDate",
  "installing",
  "progress",
  "error",
  "busyRecording",
] as const;

function isStatusKind(v: string): v is (typeof kinds)[number] {
  return (kinds as readonly string[]).includes(v);
}

function fractionFromProgress(downloaded: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  return Math.min(1, Math.max(0, downloaded / total));
}

console.assert(isStatusKind("upToDate"), "upToDate tag");
console.assert(isStatusKind("busyRecording"), "busyRecording tag");
console.assert(isStatusKind("progress"), "progress tag");
console.assert(!isStatusKind("up_to_date"), "snake_case rejected");
console.assert(fractionFromProgress(50, 100) === 0.5, "half downloaded");
console.assert(fractionFromProgress(50, null) === null, "no total → indeterminate");
console.assert(fractionFromProgress(1, 0) === null, "zero total → indeterminate");

console.log("updateToast.selfcheck: ok");

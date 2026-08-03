/** Selfcheck: GPU context-loss policy + listener preventDefault. */
import {
  attachContextLossHandlers,
  decideRecovery,
  GpuContextLostError,
  isGpuContextLostError,
  MAX_RECOVER_ATTEMPTS,
  probeWebGlAvailable,
  RECOVER_WINDOW_MS,
} from "./gpuLifecycle.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const first = decideRecovery({
  attempts: 0,
  lastAttemptAtMs: null,
  nowMs: 1_000,
});
assert(first.decision === "retry" && first.nextAttempts === 1, "first loss retries");

const mid = decideRecovery({
  attempts: 2,
  lastAttemptAtMs: 1_000,
  nowMs: 2_000,
});
assert(mid.decision === "retry" && mid.nextAttempts === 3, "third attempt still retries");

const capped = decideRecovery({
  attempts: MAX_RECOVER_ATTEMPTS,
  lastAttemptAtMs: 1_000,
  nowMs: 2_000,
});
assert(capped.decision === "giveUp", "at cap gives up");

const stale = decideRecovery({
  attempts: MAX_RECOVER_ATTEMPTS,
  lastAttemptAtMs: 1_000,
  nowMs: 1_000 + RECOVER_WINDOW_MS + 1,
});
assert(
  stale.decision === "retry" && stale.nextAttempts === 1,
  "stale window resets attempts",
);

assert(isGpuContextLostError(new GpuContextLostError()), "typed loss error");
assert(!isGpuContextLostError(new Error("no GPU")), "plain error is not loss");

{
  const target = new EventTarget();
  let lostCount = 0;
  const detach = attachContextLossHandlers(target, () => {
    lostCount += 1;
  });
  const ev = new Event("webglcontextlost", { cancelable: true });
  target.dispatchEvent(ev);
  assert(ev.defaultPrevented, "loss handler must preventDefault");
  assert(lostCount === 1, "onLost called once");
  detach();
  target.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  assert(lostCount === 1, "disposer removes listener");
}

assert(typeof probeWebGlAvailable() === "boolean", "probe returns boolean");

console.log("gpuLifecycle.selfcheck: ok");

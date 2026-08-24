/** Selfcheck: annotation overlay GPU-loss policy + 2D context-loss listeners. */
import {
  attachCanvas2dContextLoss,
  planOverlayRecovery,
} from "./overlayGpuGuard.ts";
import { MAX_RECOVER_ATTEMPTS, RECOVER_WINDOW_MS } from "../editor/render/gpuLifecycle.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// A first loss recovers: the overlay hides, rebuilds, and comes back.
const first = planOverlayRecovery({ attempts: 0, lastAttemptAtMs: null }, 1_000);
assert(first.action === "recover", "first loss recovers");
assert(first.next.attempts === 1, "the loss is counted");
assert(first.next.lastAttemptAtMs === 1_000, "and stamped");

// Repeated losses eventually stop re-showing. Re-showing into a dead GPU is
// what would flicker the whole desktop black over and over.
let state = { attempts: 0, lastAttemptAtMs: null as number | null };
let now = 1_000;
for (let i = 0; i < MAX_RECOVER_ATTEMPTS; i++) {
  const step = planOverlayRecovery(state, now);
  assert(step.action === "recover", `attempt ${i + 1} still recovers`);
  state = step.next;
  now += 1_000;
}
assert(
  planOverlayRecovery(state, now).action === "stayHidden",
  "past the cap the overlay stays hidden instead of blacking the screen again",
);

// Losses far enough apart are unrelated incidents, so a user who hits one bad
// moment an hour into a session is not locked out of live ink.
const laterOn = planOverlayRecovery(
  { attempts: MAX_RECOVER_ATTEMPTS, lastAttemptAtMs: 0 },
  RECOVER_WINDOW_MS + 1,
);
assert(laterOn.action === "recover", "a stale streak does not count against a fresh loss");

// The listener must call preventDefault, or the engine may never restore the
// context, and it must use the 2D event names rather than the WebGL ones.
let prevented = false;
let lost = 0;
let restored = 0;
const listeners = new Map<string, (e: Event) => void>();
const fakeCanvas: EventTarget = {
  addEventListener: (type: string, fn: EventListenerOrEventListenerObject) =>
    listeners.set(type, fn as (e: Event) => void),
  removeEventListener: (type: string) => listeners.delete(type),
  dispatchEvent: () => true,
};

const detach = attachCanvas2dContextLoss(fakeCanvas, {
  onLost: () => (lost += 1),
  onRestored: () => (restored += 1),
});
assert(listeners.has("contextlost"), "listens for the canvas 2D loss event");
assert(
  !listeners.has("webglcontextlost"),
  "must not listen for the WebGL event name — a 2D canvas never fires it",
);

listeners.get("contextlost")!({
  preventDefault: () => (prevented = true),
} as unknown as Event);
assert(prevented, "loss is preventDefault-ed so the context may be restored");
assert(lost === 1, "loss reaches the handler");

listeners.get("contextrestored")!({} as Event);
assert(restored === 1, "restore reaches the handler");

detach();
assert(listeners.size === 0, "detach removes both listeners");

console.log("overlayGpuGuard.selfcheck: ok");

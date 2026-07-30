/** 3-2-1 countdown — fixed square badge (never stretches with window). */

import { useEffect, useRef, useState } from "react";
import {
  initialCountdownState,
  markFired,
  shouldFire,
  tickCountdown,
} from "./countdownTick";

/** Must match `LAYOUT_COUNTDOWN` in windows.rs */
const BADGE_PX = 240;

export function Countdown({ from = 3, onDone }: { from?: number; onDone: () => void }) {
  const [state, setState] = useState(() => initialCountdownState(from));

  // `onDone` may be an inline arrow at the call site, so its identity can change
  // on every parent render. Holding it in a ref keeps it out of the effect deps —
  // otherwise each parent render restarts the 1s timer (the countdown stalls) and
  // re-invokes the completion callback (a second `startRecording`, which the Rust
  // `Busy` guard then rejects with a visible error).
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // Depends on `state.n` only: latching `fired` must not restart the timer.
  useEffect(() => {
    if (state.n <= 0) return;
    const timer = window.setTimeout(() => setState(tickCountdown), 1000);
    return () => window.clearTimeout(timer);
  }, [state.n]);

  // Re-entrancy guard, not a second latch. `state.fired` is the durable one, but
  // `setState` is async — so two invocations of this effect within one commit
  // would both still see `fired: false`. That happens for real: this window runs
  // under `React.StrictMode` (see `main.tsx`), which double-invokes mount
  // effects, and with `from={0}` the fire condition is already true at mount.
  // A ref updates synchronously, so the second invocation bails.
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current || !shouldFire(state)) return;
    firedRef.current = true;
    // Latch in state too, so a re-render from the callback observes `fired: true`.
    setState(markFired);
    onDoneRef.current();
  }, [state]);

  if (state.n <= 0) return null;

  return (
    <div className="grid h-full w-full place-items-center bg-transparent">
      <div
        className="relative overflow-hidden bg-neutral-950/90"
        style={{
          width: BADGE_PX,
          height: BADGE_PX,
          borderRadius: BADGE_PX * 0.18,
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% 46%, rgba(255,255,255,0.26) 0%, rgba(255,255,255,0.08) 32%, transparent 64%)",
          }}
        />
        <div className="relative z-10 grid h-full w-full place-items-center">
          <span
            key={state.n}
            className="leading-none font-semibold tracking-tight text-white tabular-nums animate-in zoom-in-95 fade-in duration-200"
            style={{ fontSize: BADGE_PX * 0.48 }}
          >
            {state.n}
          </span>
        </div>
      </div>
    </div>
  );
}

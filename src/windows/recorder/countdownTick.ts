/**
 * Countdown state transition, extracted so it can be self-checked without
 * rendering React.
 *
 * The countdown must fire its completion callback exactly once. Keeping "have we
 * fired" in the returned state — rather than inferring it from `n <= 0` — is
 * what makes double-fire impossible: `n <= 0` is a *condition* that stays true
 * across re-renders, while `fired` is an *event* that happens once.
 */
export type CountdownState = {
  /** Remaining count. `0` means the countdown has elapsed. */
  n: number;
  /** True once the completion callback has been invoked. */
  fired: boolean;
};

export function initialCountdownState(from: number): CountdownState {
  return { n: Math.max(0, Math.floor(from)), fired: false };
}

/** One 1-second tick. Never goes below zero. */
export function tickCountdown(state: CountdownState): CountdownState {
  if (state.n <= 0) return state;
  return { n: state.n - 1, fired: state.fired };
}

/** True when the completion callback should run right now (and never again). */
export function shouldFire(state: CountdownState): boolean {
  return state.n <= 0 && !state.fired;
}

export function markFired(state: CountdownState): CountdownState {
  return state.fired ? state : { n: state.n, fired: true };
}

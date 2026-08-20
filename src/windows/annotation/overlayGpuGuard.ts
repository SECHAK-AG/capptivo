/**
 * Keeps a lost GPU context from blanking the user's desktop (#25).
 *
 * The annotation overlay is a fullscreen, transparent, always-on-top WebView2
 * window. That combination is fine until WebView2's GPU context resets — the
 * surface then composites *opaque*, and because the window covers the whole
 * screen and sits above everything, the entire desktop goes black in the middle
 * of a recording. Nothing recovers it, because nothing was watching.
 *
 * The important move on a loss is therefore not "repaint the ink". It is **stop
 * covering the screen**: a hidden window cannot paint black over anything. Ink
 * is safe regardless — `AnnotationEngine` keeps strokes as history data, not as
 * pixels, so a rebuilt context repaints them exactly.
 *
 * Recovery is bounded by the editor's existing policy (`decideRecovery`). If the
 * GPU keeps dying, the overlay stays hidden rather than flickering the desktop
 * black on every attempt — a recording without live ink beats a recording of a
 * black screen, and the user still has their content.
 *
 * Pure on purpose: selfchecks run under plain Node with no Vite aliases and no
 * DOM, so the policy is separated from the DOM plumbing that uses it.
 */

import { decideRecovery } from "../editor/render/gpuLifecycle.ts";

/** What the overlay should do after its drawing context died. */
export type OverlayGpuAction =
  /** Rebuild the context and show the overlay again. */
  | "recover"
  /** Lost too often — leave the overlay hidden for the rest of the session. */
  | "stayHidden";

export interface OverlayRecoveryState {
  /** Losses handled so far inside the current window. */
  attempts: number;
  /** When the last one was handled, or `null` if this is the first. */
  lastAttemptAtMs: number | null;
}

/**
 * Decide what to do about one context loss.
 *
 * Delegates the "how many times, how recently" question to the editor's
 * `decideRecovery` so both windows give up on the same terms; losses spread far
 * enough apart are unrelated incidents and reset the counter there.
 */
export function planOverlayRecovery(
  state: OverlayRecoveryState,
  nowMs: number,
): { action: OverlayGpuAction; next: OverlayRecoveryState } {
  const { decision, nextAttempts } = decideRecovery({
    attempts: state.attempts,
    lastAttemptAtMs: state.lastAttemptAtMs,
    nowMs,
  });
  return {
    action: decision === "retry" ? "recover" : "stayHidden",
    next: { attempts: nextAttempts, lastAttemptAtMs: nowMs },
  };
}

/**
 * Attach canvas 2D context-loss listeners.
 *
 * Note these are `contextlost` / `contextrestored` — *not* the `webglcontext*`
 * pair the editor uses. The overlay draws with a 2D context, which fires its
 * own events; listening for the WebGL names here would silently never fire.
 *
 * `preventDefault()` on loss is what tells the engine it may restore the
 * context rather than abandoning it for good.
 */
export function attachCanvas2dContextLoss(
  canvas: EventTarget,
  handlers: { onLost: () => void; onRestored: () => void },
): () => void {
  const handleLost = (event: Event) => {
    event.preventDefault();
    handlers.onLost();
  };
  const handleRestored = () => handlers.onRestored();
  canvas.addEventListener("contextlost", handleLost);
  canvas.addEventListener("contextrestored", handleRestored);
  return () => {
    canvas.removeEventListener("contextlost", handleLost);
    canvas.removeEventListener("contextrestored", handleRestored);
  };
}

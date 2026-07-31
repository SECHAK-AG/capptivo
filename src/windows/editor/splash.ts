/**
 * HTML splash in `editor.html` — dismiss once, then gone.
 * No React state, no animation libs, no extra window.
 */

let dismissed = false;

/** Fade out and remove `#splash`. Idempotent and safe if the node is missing. */
export function dismissEditorSplash(): void {
  if (dismissed) return;
  const el = document.getElementById("splash");
  if (!el) {
    dismissed = true;
    return;
  }
  dismissed = true;
  el.classList.add("is-hiding");
  el.setAttribute("aria-busy", "false");
  const remove = () => el.remove();
  el.addEventListener("transitionend", remove, { once: true });
  // transitionend can miss (reduced motion / already opacity 0).
  window.setTimeout(remove, 220);
}

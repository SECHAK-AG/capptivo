/**
 * Shared WebGL/WebGPU lifecycle for preview + export.
 *
 * Windows WebView2 can lose the GPU context under load (TDR). Pixi then
 * misreports "browser does not support WebGL" on remount. Detect loss, reclaim
 * before remounting, and reload the editor webview if the GPU process stays dead.
 *
 * ponytail: `location.reload()` instead of WebView2 ProcessFailed — Tauri does
 * not expose that event yet; upgrade when wry/tauri adds it.
 */

export const MAX_RECOVER_ATTEMPTS = 3;
/** Losses this far apart are unrelated incidents, so the counter resets. */
export const RECOVER_WINDOW_MS = 60_000;

export const GPU_RELOADED_STORAGE_KEY = "capptivo:gpuReloaded";

export type RecoveryDecision = "retry" | "giveUp";

export function decideRecovery(args: {
  attempts: number;
  lastAttemptAtMs: number | null;
  nowMs: number;
}): { decision: RecoveryDecision; nextAttempts: number } {
  const stale =
    args.lastAttemptAtMs != null &&
    args.nowMs - args.lastAttemptAtMs > RECOVER_WINDOW_MS;
  const attempts = stale ? 0 : args.attempts;
  if (attempts >= MAX_RECOVER_ATTEMPTS) {
    return { decision: "giveUp", nextAttempts: attempts };
  }
  return { decision: "retry", nextAttempts: attempts + 1 };
}

export class GpuContextLostError extends Error {
  readonly name = "GpuContextLostError";
  constructor(message = "GPU context lost") {
    super(message);
  }
}

export function isGpuContextLostError(e: unknown): boolean {
  return e instanceof GpuContextLostError;
}

/**
 * Attach webglcontextlost / webglcontextrestored. On loss, always
 * `preventDefault()` so the browser may restore; then call `onLost`.
 */
export function attachContextLossHandlers(
  target: EventTarget,
  onLost: (event: Event) => void,
): () => void {
  const handleLost = (event: Event) => {
    if (
      typeof (event as { preventDefault?: () => void }).preventDefault ===
      "function"
    ) {
      event.preventDefault();
    }
    onLost(event);
  };
  const handleRestored = () => {
    console.info("[gpu] webglcontextrestored");
  };
  target.addEventListener("webglcontextlost", handleLost);
  target.addEventListener("webglcontextrestored", handleRestored);
  return () => {
    target.removeEventListener("webglcontextlost", handleLost);
    target.removeEventListener("webglcontextrestored", handleRestored);
  };
}

/** True after at least one Pixi/WebGL compositor has initialized this session. */
let hadSuccessfulGpuContext = false;

export function markGpuContextSucceeded(): void {
  hadSuccessfulGpuContext = true;
}

export function hasHadSuccessfulGpuContext(): boolean {
  return hadSuccessfulGpuContext;
}

/**
 * Session flag: after Offscreen init failure or context loss, prefer a DOM
 * canvas for the rest of this editor session (more stable on Windows WebView2).
 * Offscreen stays the default until then — export speed is preserved.
 */
let preferDomCanvasForExport = false;

export function shouldPreferDomCanvasForExport(): boolean {
  return preferDomCanvasForExport;
}

export function markPreferDomCanvasForExport(reason: string): void {
  if (preferDomCanvasForExport) return;
  preferDomCanvasForExport = true;
  console.warn(`[gpu] prefer DOM canvas for export: ${reason}`);
}

/** Tiny throwaway WebGL probe — true if a context can still be allocated. */
export function probeWebGlAvailable(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const attrs: WebGLContextAttributes = {
      failIfMajorPerformanceCaveat: false,
      powerPreference: "default",
    };
    const ctx =
      canvas.getContext("webgl2", attrs) ?? canvas.getContext("webgl", attrs);
    if (!ctx || ctx.isContextLost()) return false;
    const ext = ctx.getExtension("WEBGL_lose_context");
    ext?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After a known loss: settle GL reclaim, then probe. Caller reloads if `ok` is false.
 * Does not import previewGpuGate (selfchecks load this module without Vite).
 */
export async function reclaimGpuAfterLoss(): Promise<{ ok: boolean }> {
  await nextFrame();
  await nextFrame();
  // Extra settle beyond two frames — driver reset is slower than dispose.
  await delay(50);
  const ok = probeWebGlAvailable();
  console.info(`[gpu] reclaim probe ${ok ? "ok" : "failed"}`);
  return { ok };
}

/**
 * Persist a one-shot banner and reload this webview so WebView2 gets a fresh
 * GPU process. Call only after flushing editor persist (pagehide also flushes).
 */
export function reloadEditorForDeadGpu(): void {
  try {
    sessionStorage.setItem(GPU_RELOADED_STORAGE_KEY, "1");
  } catch {
    // sessionStorage may throw in rare private modes — still reload.
  }
  location.reload();
}

/** If the editor just reloaded after a dead GPU, clear the flag and return true. */
export function consumeGpuReloadedBanner(): boolean {
  try {
    if (sessionStorage.getItem(GPU_RELOADED_STORAGE_KEY) !== "1") return false;
    sessionStorage.removeItem(GPU_RELOADED_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exclusive GPU ownership between the editor preview and export.
 *
 * Preview and export each need a Pixi WebGL/WebGPU renderer. Holding both at
 * once is what breaks OffscreenCanvas init on some Windows WebView2 setups
 * (and can leave the preview/library white after a failed export). Export
 * waits here until preview has disposed its renderer before creating its own.
 */

let held = false;
const waiters: Array<() => void> = [];

/** Preview owns a live GPU compositor (or is creating one). */
export function markPreviewGpuHeld(): void {
  held = true;
}

/** Preview disposed its compositor — export may create OffscreenCanvas now. */
export function releasePreviewGpu(): void {
  if (!held && waiters.length === 0) return;
  held = false;
  const pending = waiters.splice(0, waiters.length);
  for (const resolve of pending) resolve();
}

export function isPreviewGpuHeld(): boolean {
  return held;
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

/**
 * Wait until preview has released its GPU context, then yield a couple of
 * frames so the browser can reclaim the GL context before export allocates.
 */
export async function waitForPreviewGpuRelease(): Promise<void> {
  if (held) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
  // ponytail: GL context free is async after dispose — two frames is enough;
  // if a driver still races, export's own init retry/fallback covers it.
  await nextFrame();
  await nextFrame();
}

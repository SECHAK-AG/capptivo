/** Selfcheck: exclusive preview/export GPU gate. */
import {
  isPreviewGpuHeld,
  markPreviewGpuHeld,
  releasePreviewGpu,
  waitForPreviewGpuRelease,
} from "./previewGpuGate.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function run(): Promise<void> {
  releasePreviewGpu();
  assert(!isPreviewGpuHeld(), "starts released");

  markPreviewGpuHeld();
  assert(isPreviewGpuHeld(), "held after mark");

  let released = false;
  const waiting = waitForPreviewGpuRelease().then(() => {
    released = true;
  });
  assert(!released, "wait blocks while held");

  releasePreviewGpu();
  await waiting;
  assert(released, "wait resolves after release");
  assert(!isPreviewGpuHeld(), "released");

  // Nothing held — must not hang.
  await waitForPreviewGpuRelease();

  console.log("previewGpuGate.selfcheck: ok");
}

await run();

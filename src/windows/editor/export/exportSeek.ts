/** Per-frame `<video>` seek — isolated so exportFrameLoop selfchecks stay light. */

import { ExportCancelledError } from "./exportCancel.ts";

export const EXPORT_SEEK_TIMEOUT_MS = 10_000;

export type SeekOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export function seekTo(
  video: HTMLVideoElement,
  time: number,
  options: SeekOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 0.001) {
      resolve();
      return;
    }
    const timeoutMs = options.timeoutMs ?? EXPORT_SEEK_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("seek failed"));
    };
    const onAbort = () => {
      cleanup();
      reject(new ExportCancelledError());
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onErr);
      options.signal?.removeEventListener("abort", onAbort);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onErr, { once: true });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`seek timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      video.currentTime = time;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** Flush helper for the camera bubble WebView. */

import { listen } from "@tauri-apps/api/event";
import { commands } from "@/ipc/bindings";

/**
 * Whether the bubble confirmed its flush, or the wait ran out.
 *
 * The distinction matters: `stop_recording` drops the camera sink as soon as it
 * runs, so any MediaRecorder chunk still in flight afterwards is rejected with
 * "no open camera file" and the WebM keeps whatever tail it had. `is_usable`
 * only checks that the file is bigger than 2 KB, so a truncated capture is
 * still handed to the editor, where it plays as no face-cam at all (#22).
 *
 * That used to happen silently. Returning the outcome lets the caller say so.
 */
export type CameraFlushOutcome = "flushed" | "timed-out";

export async function flushCameraCaptureWithTimeout(
  ms = 4000,
): Promise<CameraFlushOutcome> {
  let unlisten: (() => void) | undefined;
  try {
    return await new Promise<CameraFlushOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: CameraFlushOutcome) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(outcome);
      };
      const timer = window.setTimeout(() => finish("timed-out"), ms);
      void listen("camera://capture-flushed", () => finish("flushed")).then(
        (un) => {
          unlisten = un;
          if (settled) {
            un();
            return;
          }
          // A failed invoke is not a flush — the bubble never confirmed, so the
          // tail of the capture is exactly as at risk as a timeout.
          void commands.flushCameraCapture().catch(() => finish("timed-out"));
        },
      );
    });
  } finally {
    unlisten?.();
  }
}

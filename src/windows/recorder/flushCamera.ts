/** Flush helper for the camera bubble WebView. */

import { listen } from "@tauri-apps/api/event";
import { commands } from "@/ipc/bindings";

export async function flushCameraCaptureWithTimeout(ms = 4000): Promise<void> {
  let unlisten: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      void listen("camera://capture-flushed", finish).then((un) => {
        unlisten = un;
        if (settled) {
          un();
          return;
        }
        void commands.flushCameraCapture().catch(finish);
      });
    });
  } finally {
    unlisten?.();
  }
}

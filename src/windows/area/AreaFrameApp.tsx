/**
 * Click-through on-screen guide — shows crop bounds after pick and during
 * recording. Not captured in the video (separate overlay window).
 */

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AreaRegionChrome, type AreaRect } from "./AreaRegionChrome";

export function AreaFrameApp() {
  const [rect, setRect] = useState<AreaRect | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AreaRect>("area-frame://rect", (e) => setRect(e.payload)).then(
      (fn) => {
        unlisten = fn;
      },
    );
    return () => unlisten?.();
  }, []);

  if (!rect) return null;

  return (
    <div className="pointer-events-none relative h-screen w-screen overflow-hidden">
      <AreaRegionChrome rect={rect} />
    </div>
  );
}

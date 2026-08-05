import React from "react";
import ReactDOM from "react-dom/client";
import { setCursorDebugOverlay } from "@/engine";
import { AppToaster } from "@/lib/toast";
import { UpdateNotifier } from "@/lib/updateToast";
import { SettingsProvider } from "@/lib/settings";
import { initTheme } from "@/lib/theme";
import { installErrorLogging } from "@/lib/errorLogging";
import { EditorApp } from "./EditorApp";
import "../../styles.css";

installErrorLogging("editor");
document.documentElement.classList.add("editor-shell");
// Apply the stored theme to <html> before first paint to avoid a theme flash.
initTheme();

if (import.meta.env.DEV) {
  // `__cursorDebug(true)` marks the raw recorded sample with a crosshair, so a
  // paused frame says whether a cursor that looks misaligned is the position
  // being wrong or the glyph sitting wrong on a correct position.
  // Nudge the playhead after toggling to force a repaint.
  (globalThis as { __cursorDebug?: (on: boolean) => void }).__cursorDebug =
    setCursorDebugOverlay;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsProvider>
      <EditorApp />
      <UpdateNotifier />
      <AppToaster />
    </SettingsProvider>
  </React.StrictMode>,
);

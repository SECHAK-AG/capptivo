import ReactDOM from "react-dom/client";
import { SettingsProvider } from "@/lib/settings";
import { initTheme } from "@/lib/theme";
import { installErrorLogging } from "@/lib/errorLogging";
import { AnnotationApp } from "./AnnotationApp";
import "../../styles.css";

installErrorLogging("annotation");
document.documentElement.classList.add("annotation-shell");
// Same as the editor: apply stored light/dark before paint so the bar matches
// Capptivo's theme (tokens are already semantic — only the html class was missing).
initTheme();

// No StrictMode — double-mount would leak listeners / stop getUserMedia.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <SettingsProvider>
    <AnnotationApp />
  </SettingsProvider>,
);

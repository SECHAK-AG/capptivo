import React from "react";
import ReactDOM from "react-dom/client";
import { installProductionErrorLogging } from "@/lib/log";
import { SettingsProvider } from "@/lib/settings";
import { RecorderApp } from "./RecorderApp";
import "../../styles.css";

document.documentElement.classList.add("recorder-shell");
installProductionErrorLogging();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsProvider>
      <RecorderApp />
    </SettingsProvider>
  </React.StrictMode>,
);

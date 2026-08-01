import React from "react";
import ReactDOM from "react-dom/client";
import { installProductionErrorLogging } from "@/lib/log";
import { AreaPickerApp } from "./AreaPickerApp";
import "../../styles.css";

document.documentElement.classList.add("area-shell");
installProductionErrorLogging();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AreaPickerApp />
  </React.StrictMode>,
);

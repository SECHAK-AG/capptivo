import React from "react";
import ReactDOM from "react-dom/client";
import { installErrorLogging } from "@/lib/errorLogging";
import { AreaPickerApp } from "./AreaPickerApp";
import "../../styles.css";

installErrorLogging("area-picker");
document.documentElement.classList.add("area-shell");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AreaPickerApp />
  </React.StrictMode>,
);

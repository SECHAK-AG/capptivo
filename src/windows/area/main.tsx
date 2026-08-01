import React from "react";
import ReactDOM from "react-dom/client";
import { AreaPickerApp } from "./AreaPickerApp";
import "../../styles.css";

document.documentElement.classList.add("area-shell");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AreaPickerApp />
  </React.StrictMode>,
);

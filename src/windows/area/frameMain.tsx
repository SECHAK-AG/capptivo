import React from "react";
import ReactDOM from "react-dom/client";
import { AreaFrameApp } from "./AreaFrameApp";
import "../../styles.css";

document.documentElement.classList.add("area-shell");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AreaFrameApp />
  </React.StrictMode>,
);

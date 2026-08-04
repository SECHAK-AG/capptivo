import ReactDOM from "react-dom/client";
import { installErrorLogging } from "@/lib/errorLogging";
import { CameraApp } from "./CameraApp";
import "../../styles.css";

installErrorLogging("camera");
document.documentElement.classList.add("camera-shell");

// No StrictMode — double-mount would stop getUserMedia and black the bubble.
ReactDOM.createRoot(document.getElementById("root")!).render(<CameraApp />);

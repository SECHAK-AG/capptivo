import ReactDOM from "react-dom/client";
import { installProductionErrorLogging } from "@/lib/log";
import { AnnotationApp } from "./AnnotationApp";
import "../../styles.css";

document.documentElement.classList.add("annotation-shell");
installProductionErrorLogging();

// No StrictMode — double-mount would leak listeners / stop getUserMedia.
ReactDOM.createRoot(document.getElementById("root")!).render(<AnnotationApp />);

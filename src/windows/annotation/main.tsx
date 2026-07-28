import ReactDOM from "react-dom/client";
import { AnnotationApp } from "./AnnotationApp";
import "../../styles.css";

document.documentElement.classList.add("annotation-shell");

// No StrictMode — double-mount would leak listeners / stop getUserMedia.
ReactDOM.createRoot(document.getElementById("root")!).render(<AnnotationApp />);

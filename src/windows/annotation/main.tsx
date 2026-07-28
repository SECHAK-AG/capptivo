import ReactDOM from "react-dom/client";
import { AnnotationApp } from "./AnnotationApp";
import "../../styles.css";

document.documentElement.classList.add("annotation-shell");

// No StrictMode — engine attaches window listeners; double-mount would leak.
ReactDOM.createRoot(document.getElementById("root")!).render(<AnnotationApp />);

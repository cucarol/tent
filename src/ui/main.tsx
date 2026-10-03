import { createRoot } from "react-dom/client";
import { App } from "./App.js";
// Lazily loaded chunks do not inject CSS, so the canvas styles load up front.
import "@excalidraw/excalidraw/index.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

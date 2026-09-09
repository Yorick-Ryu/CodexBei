import "./theme";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./app.css";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);

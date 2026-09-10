import "./theme";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./app.css";
import { App } from "./App";
async function mount() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).get("preview") === "windows" && !("__TAURI_INTERNALS__" in window)) {
    await import("./windows-preview");
  }
  createRoot(document.getElementById("root")!).render(<App />);
}
void mount();

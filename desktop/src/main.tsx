import "./theme";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./app.css";
import { App } from "./App";
// Reserve native macOS controls before the first render, including inspect failures.
document.body.dataset.platform = /Mac/i.test(navigator.platform) ? "darwin" : /Win/i.test(navigator.platform) ? "windows" : "linux";
async function mount() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).get("preview") === "windows" && !("__TAURI_INTERNALS__" in window)) {
    await import("./windows-preview");
  }
  createRoot(document.getElementById("root")!).render(<App />);
}
void mount();

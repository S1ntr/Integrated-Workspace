import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Apply saved theme before first render to avoid flash of wrong theme
try {
  const saved = localStorage.getItem("__integraded_theme");
  if (saved && saved !== "auto") {
    document.documentElement.setAttribute("data-theme", saved);
  } else if (!saved) {
    // Default to dark if nothing saved
    document.documentElement.setAttribute("data-theme", "dark");
  }
} catch {}

function eventInIntegratedBrowser(event: Event): boolean {
  return event.target instanceof Element && Boolean(event.target.closest(".browser-overlay"));
}

// Native app behavior — suppress browser defaults
document.addEventListener("contextmenu", (e) => {
  if (!eventInIntegratedBrowser(e)) e.preventDefault();
});
document.addEventListener("wheel", (e) => {
  if (e.ctrlKey && !eventInIntegratedBrowser(e)) e.preventDefault();
}, { passive: false });
document.addEventListener("keydown", (e) => {
  if (!eventInIntegratedBrowser(e) && e.ctrlKey && (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")) {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

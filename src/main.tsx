import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Apply saved theme before first render to avoid flash
try {
  const saved = localStorage.getItem("__integraded_theme");
  if (saved === "light") document.documentElement.setAttribute("data-theme", "light");
  else if (saved === "dark") document.documentElement.setAttribute("data-theme", "dark");
} catch {}

// Native app behavior — suppress browser defaults
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")) {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

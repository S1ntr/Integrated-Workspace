import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Apply saved theme before first render to avoid flash
try {
  const saved = localStorage.getItem("__integraded_theme");
  if (saved === "light") document.documentElement.setAttribute("data-theme", "light");
  else if (saved === "dark") document.documentElement.setAttribute("data-theme", "dark");
  // "auto" or missing = leave unset (CSS media query handles it)
} catch {}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

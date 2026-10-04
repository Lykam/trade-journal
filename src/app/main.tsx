import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Drop the ?fresh= marker left by a cache-busting reload (index.html, freshReload).
const url = new URL(window.location.href);
if (url.searchParams.has("fresh")) {
  url.searchParams.delete("fresh");
  window.history.replaceState(null, "", url.href);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Self-hosted, so the page that holds the site key loads no third-party CSS (SPEC §8).
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
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

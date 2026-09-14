import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./app.js";
import "./styles.css";
import { getTheme, setTheme } from "./lib/theme.js";

setTheme(getTheme());

// Registers the service worker and, when a new deploy is detected, reloads this
// tab once the new worker has taken over — see src/sw.ts's activate handler
// (clients.claim()) for the other half of this. Without both halves, an
// already-open tab keeps running the old build's JS indefinitely.
registerSW({
  immediate: true,
  onNeedRefresh() {
    window.location.reload();
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

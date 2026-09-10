/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // The default auto-injected registerSW.js is a bare `navigator.serviceWorker
      // .register(...)` call with no update-checking or reload-on-new-version logic
      // — registerType: "autoUpdate" alone doesn't add that for injectManifest (it
      // only affects generateSW's own generated service worker). Registering
      // manually via virtual:pwa-register in main.tsx instead, so a new deploy
      // actually replaces an already-open tab's old shell instead of leaving it
      // running stale JS until the tab is closed and reopened.
      injectRegister: false,
      // injectManifest (not the default generateSW) so src/sw.ts can add a custom
      // `push`/`notificationclick` handler for opt-in Web Push, while still getting
      // the production asset list precached the same way generateSW did.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        // the API + realtime websocket must never be served from cache
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
      },
      manifest: {
        name: "Ronmacrae Dispatch",
        short_name: "Dispatch",
        description: "Store delivery dispatch for Jamaica",
        theme_color: "#123f2e",
        background_color: "#0b1f17",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icons/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [fileURLToPath(new URL("./test/setup.ts", import.meta.url))],
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});

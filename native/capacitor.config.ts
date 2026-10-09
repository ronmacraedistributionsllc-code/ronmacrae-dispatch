import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Ronmacrae Dispatch — rider ("bearer") Android shell.
 *
 * The app loads the LIVE site (the website stays as is); new website code
 * only takes effect after the human deploys it, so the shell must degrade
 * gracefully against the currently deployed site.
 *
 * Security lock-down (decision D5): the WebView loads a remote origin that
 * can call native plugins, so navigation is restricted to the one
 * production host; every other URL must be opened in the system browser.
 */
const config: CapacitorConfig = {
  appId: "com.login.dispatched",
  appName: "Ronmacrae Dispatch",
  // Capacitor requires a local webDir even though the app loads the live
  // site via server.url — this placeholder is never the real UI.
  webDir: "www",
  server: {
    url: "https://orders.ronmacraedistributions.com",
    cleartext: false,
    allowNavigation: ["orders.ronmacraedistributions.com"],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;

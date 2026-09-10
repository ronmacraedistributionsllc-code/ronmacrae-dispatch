/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope;

// injectManifest strategy: vite-plugin-pwa replaces this with the build's asset list.
precacheAndRoute(self.__WB_MANIFEST);
// Removes the *previous* version's precache entries once this SW activates — without
// this, an old build's cached JS/CSS/HTML lingers in Cache Storage indefinitely.
cleanupOutdatedCaches();

self.skipWaiting();

// Take control of any tab that's already open, not just tabs opened after this SW
// activates — paired with main.tsx's registerSW({ onNeedRefresh: reload }), this is
// what actually replaces an already-open tab's stale shell after a new deploy,
// instead of leaving it running old JS until the tab is closed and reopened.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
}

/**
 * Opt-in Web Push handler. The payload shape here must match what
 * apps/api/src/modules/push.ts sends (title/body/tag/url) — see PushService.sendToUser.
 * A push with no permission granted, or a subscription the user revoked at the OS
 * level, never reaches here at all (the browser handles that before waking the SW).
 */
self.addEventListener("push", (event) => {
  let data: PushPayload = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    // non-JSON payload - show a generic notification rather than dropping it silently
  }
  const title = data.title ?? "Ronmacrae Dispatch";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body ?? "",
      tag: data.tag,
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      data: { url: data.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/";
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientsList.find((c) => "focus" in c);
      if (existing) {
        await (existing as WindowClient).focus();
        if ("navigate" in existing) await (existing as WindowClient).navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope;

// injectManifest strategy: vite-plugin-pwa replaces this with the build's asset list.
precacheAndRoute(self.__WB_MANIFEST);

self.skipWaiting();

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

import { API } from "@ronmacrae/contracts";
import { apiFetch } from "./api.js";

/**
 * Stops push for THIS browser/device only — never every device the account
 * has opted in on elsewhere (a rider signed in on both a phone and a
 * desktop who logs out of one shouldn't lose push on the other). Shared by
 * PushOptIn's own "Disable" button and by auth.tsx's logout() (spec's own
 * security rule: "private notifications stop after explicit logout" — a
 * push payload can carry real order/customer content, and a subscription
 * left behind after sign-out would keep delivering it to a device nobody
 * is authenticated on anymore).
 *
 * Must run BEFORE the access token is cleared — it authenticates the
 * unsubscribe call as the still-logged-in user — and must never throw: a
 * failed best-effort cleanup here must not block the sign-out itself.
 */
export async function unsubscribeThisDeviceFromPush(): Promise<void> {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    // `.ready` (not `getRegistration()`, which can resolve `undefined` even
    // when a registration is still in flight) — same API PushOptIn's own
    // enable/disable already rely on. Raced against a short timeout since,
    // unlike PushOptIn (only reachable once push is already confirmed
    // working), this runs on every sign-out app-wide — a service worker
    // that never activates must never hang the sign-out itself.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    try {
      await apiFetch(API.push.unsubscribe, { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
    } catch {
      // best-effort — still unsubscribe the browser side below even if the
      // server call failed (e.g. the session was already gone)
    }
    await sub.unsubscribe();
  } catch {
    // never block sign-out on push cleanup
  }
}

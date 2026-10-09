import { isNative } from "./platform.js";

/**
 * Thin typed adapter over `@capacitor/push-notifications` (FCM token +
 * listeners) and `@capacitor/local-notifications` (Android channels).
 *
 * Both packages are loaded with dynamic `import()` only after `isNative()`
 * is true, so the normal web bundle has no new eager imports. Every
 * function degrades gracefully outside the shell ("unsupported") and never
 * throws into the caller — the components decide what to show.
 *
 * NOTE (Phase 4): registering the FCM token with the API
 * (`POST /api/push/native/register`, unregister on logout, refresh on
 * rotation) is NOT wired here yet — the routes don't exist. `enableNativePush`
 * gets the device token as far as the OS; server sync lands in Phase 4.
 */

export type NativePushStatus = "unsupported" | "denied" | "off" | "on" | "error";

/** Channel IDs must match what the API sends as `android.notification.channel_id` (Phase 4). */
export const NATIVE_CHANNEL_JOB_OFFERS = "job_offers";
export const NATIVE_CHANNEL_MESSAGES = "messages";
export const NATIVE_CHANNEL_ACTIVE_DELIVERY = "active_delivery";

/** True once this session completed register() — permission alone is not enough. */
let registeredThisSession = false;

async function createChannels(): Promise<void> {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  // Customer-safe lock-screen text is enforced by the channel visibility +
  // the payload copy (Phase 4). `visibility: "private"` shows a generic
  // public version on the lock screen instead of the full content.
  await LocalNotifications.createChannel({
    id: NATIVE_CHANNEL_JOB_OFFERS,
    name: "Delivery offers",
    description: "New job offers and assignments. Wake the phone with a loud sound.",
    // IMPORTANCE_HIGH (4). A custom loud sound in res/raw is attached in
    // Phase 4 — note channels are immutable once created, so a reinstall
    // may be needed to pick the sound up on test devices.
    importance: 4,
    visibility: 0,
    vibration: true,
  });
  await LocalNotifications.createChannel({
    id: NATIVE_CHANNEL_ACTIVE_DELIVERY,
    name: "Active delivery",
    description: "Lock-screen presence while a delivery is in progress.",
    importance: 2,
    visibility: 1,
  });
  await LocalNotifications.createChannel({
    id: NATIVE_CHANNEL_MESSAGES,
    name: "Messages",
    description: "Dispatch and customer messages.",
    importance: 3,
    visibility: 0,
  });
}

/**
 * What the OS reports. "on" means this session registered for FCM;
 * "off" means permission is granted but register() hasn't run (or the app
 * restarted — server-side registration state is reconciled in Phase 4).
 */
export async function getNativePushStatus(): Promise<NativePushStatus> {
  if (!isNative()) return "unsupported";
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const perm = await PushNotifications.checkPermissions();
    if (perm.receive === "denied") return "denied";
    if (perm.receive !== "granted") return "off";
    return registeredThisSession ? "on" : "off";
  } catch {
    return "error";
  }
}

/**
 * Short in-app explanation first (caller shows it), then the OS prompt,
 * then channel creation + FCM registration. Resolves with the resulting
 * status and, when a token arrives, calls `onToken` (Phase 4 persists it).
 */
export async function enableNativePush(onToken: (token: string) => void): Promise<NativePushStatus> {
  if (!isNative()) return "unsupported";
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== "granted") perm = await PushNotifications.requestPermissions();
    if (perm.receive === "denied") return "denied";
    if (perm.receive !== "granted") return "off";
    // Channels must exist before the first notification can use them.
    await createChannels();
    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener("registration", (token) => {
      registeredThisSession = true;
      onToken(token.value);
    });
    await PushNotifications.addListener("registrationError", () => {
      registeredThisSession = false;
    });
    await PushNotifications.register();
    registeredThisSession = true;
    return "on";
  } catch {
    registeredThisSession = false;
    return "error";
  }
}

/** Best-effort teardown (logout also unregisters server-side in Phase 4). */
export async function disableNativePush(): Promise<void> {
  registeredThisSession = false;
  if (!isNative()) return;
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await PushNotifications.removeAllListeners();
  } catch {
    // never block sign-out on push cleanup
  }
}

/** Fires when the user taps a notification (foreground, background, or cold start). */
export function onNativeNotificationTap(onTap: (url: string) => void): () => void {
  if (!isNative()) return () => {};
  let detach: (() => void) | null = null;
  let cancelled = false;
  void import("@capacitor/push-notifications")
    .then(({ PushNotifications }) => {
      if (cancelled) return;
      void PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
        const data = action.notification?.data as { url?: unknown } | undefined;
        const url = typeof data?.url === "string" && data.url.startsWith("/") ? data.url : "/";
        onTap(url);
      }).then((handle) => {
        if (cancelled) void handle.remove();
        else detach = () => void handle.remove();
      });
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    detach?.();
  };
}

/** Test-only reset of the module-level registration flag. */
export function __resetNativePushForTests(): void {
  registeredThisSession = false;
}

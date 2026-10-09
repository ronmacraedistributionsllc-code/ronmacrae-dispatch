import { isNative } from "./platform.js";

/**
 * App-lifecycle adapter over `@capacitor/app`.
 *
 * Dynamic `import()` only when native; no-op subscriptions elsewhere.
 * Used for notification-tap deep links (`data.url`, including cold start —
 * the OS reopens the single-task activity and the plugin emits
 * `appUrlOpen` / the push action listener fires).
 */

/** Fires with the deep-link URL the app was opened with. Returns an unsubscribe function. */
export function onNativeDeepLink(onOpen: (url: string) => void): () => void {
  if (!isNative()) return () => {};
  let detach: (() => void) | null = null;
  let cancelled = false;
  void import("@capacitor/app")
    .then(({ App }) => {
      if (cancelled) return;
      void App.addListener("appUrlOpen", (data) => onOpen(data.url)).then((handle) => {
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

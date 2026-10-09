import { isNative } from "./platform.js";

/**
 * Native network status via `@capacitor/network` (more reliable
 * connectivity changes than `navigator.onLine` in a WebView).
 *
 * Loaded with a dynamic `import()` only when native. Outside the shell this
 * is a no-op subscription — the existing `navigator.onLine` handling in
 * `lib/realtime.tsx` stays exactly as is. Phase 6 wires this into
 * `ConnectionStatus` for riders.
 */

/** Subscribe to connectivity changes. Returns an unsubscribe function. */
export function watchNativeNetwork(onChange: (online: boolean) => void): () => void {
  if (!isNative()) return () => {};
  let detach: (() => void) | null = null;
  let cancelled = false;
  void import("@capacitor/network")
    .then(({ Network }) => {
      if (cancelled) return;
      void Network.getStatus()
        .then((status) => {
          if (!cancelled) onChange(status.connected);
        })
        .catch(() => {});
      void Network.addListener("networkStatusChange", (status) => onChange(status.connected)).then((handle) => {
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

/** One-shot connectivity check. Falls back to `navigator.onLine` outside the shell. */
export async function isNativeOnline(): Promise<boolean> {
  if (!isNative()) return navigator.onLine !== false;
  try {
    const { Network } = await import("@capacitor/network");
    const status = await Network.getStatus();
    return status.connected;
  } catch {
    return navigator.onLine !== false;
  }
}

import React, { useEffect, useState } from "react";
import { API } from "@ronmacrae/contracts";
import { apiFetch, ApiError } from "../lib/api.js";
import { unsubscribeThisDeviceFromPush } from "../lib/push.js";

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Status = "unsupported" | "checking" | "off" | "on" | "denied";

/**
 * Explicit opt-in Web Push toggle. Never auto-subscribes — the user must click
 * "Enable" (which triggers the browser's own permission prompt). Reflects the
 * browser's actual subscription state on mount, not just local component state,
 * so it stays correct across page reloads and OS-level permission changes.
 */
export function PushOptIn(): React.JSX.Element | null {
  const [status, setStatus] = useState<Status>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        setStatus(sub ? "on" : "off");
      } catch {
        setStatus("off");
      }
    })();
  }, []);

  async function enable(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "off");
        return;
      }
      const { publicKey } = await apiFetch<{ publicKey: string }>(API.push.publicKey);
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await apiFetch(API.push.subscribe, { method: "POST", body: JSON.stringify(json) });
      setStatus("on");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Same device-scoped cleanup logout() runs automatically — see its
      // own doc comment (lib/push.ts) for why only this browser's
      // subscription is touched.
      await unsubscribeThisDeviceFromPush();
      setStatus("off");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disable notifications");
    } finally {
      setBusy(false);
    }
  }

  if (status === "unsupported" || status === "checking") return null;
  if (status === "denied") {
    return <p className="text-xs text-zinc-500">Notifications are blocked in your browser settings.</p>;
  }

  return (
    <div className="flex items-center gap-2">
      <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => void (status === "on" ? disable() : enable())}>
        {busy ? "Working…" : status === "on" ? "Disable push notifications" : "Enable push notifications"}
      </button>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}

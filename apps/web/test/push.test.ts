import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccessToken } from "../src/lib/api.js";
import { unsubscribeThisDeviceFromPush } from "../src/lib/push.js";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body } as Response;
}

/** Spec's own security rule: "private notifications stop after explicit
 *  logout" — see push.ts's own doc comment for exactly what this does and
 *  doesn't touch (this device's subscription only, never every device the
 *  account has push enabled on). */
describe("unsubscribeThisDeviceFromPush", () => {
  const originalServiceWorker = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  const originalPushManager = (window as unknown as { PushManager?: unknown }).PushManager;

  beforeEach(() => {
    setAccessToken("access-1");
    Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });
  });

  afterEach(() => {
    setAccessToken(null);
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "serviceWorker", { value: originalServiceWorker, configurable: true });
    Object.defineProperty(window, "PushManager", { value: originalPushManager, configurable: true });
  });

  it("unsubscribes both the server-side subscription and the browser's own, when one exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getSubscription = vi.fn().mockResolvedValue({ endpoint: "https://push.example/abc123", unsubscribe });
    Object.defineProperty(navigator, "serviceWorker", {
      value: { ready: Promise.resolve({ pushManager: { getSubscription } }) },
      configurable: true,
    });

    await unsubscribeThisDeviceFromPush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/push/unsubscribe");
    expect(JSON.parse(init.body as string)).toEqual({ endpoint: "https://push.example/abc123" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does nothing — no fetch call, no throw — when this device was never subscribed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "serviceWorker", {
      value: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } }) },
      configurable: true,
    });

    await expect(unsubscribeThisDeviceFromPush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still unsubscribes the browser side even when the server call fails — never blocks sign-out", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { error: { message: "boom" } }));
    vi.stubGlobal("fetch", fetchMock);
    const unsubscribe = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        ready: Promise.resolve({
          pushManager: { getSubscription: vi.fn().mockResolvedValue({ endpoint: "https://push.example/xyz", unsubscribe }) },
        }),
      },
      configurable: true,
    });

    await expect(unsubscribeThisDeviceFromPush()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("never throws when the browser has no push support at all", async () => {
    // Not just an absent subscription — the property itself doesn't exist
    // on this browser's `navigator`, the real shape of an unsupported
    // browser (checked with `"serviceWorker" in navigator`, not truthiness).
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    await expect(unsubscribeThisDeviceFromPush()).resolves.toBeUndefined();
  });

  it("never hangs sign-out — a service worker that never activates times out instead of blocking forever", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      // A `.ready` that never resolves — the real failure mode this guards against.
      Object.defineProperty(navigator, "serviceWorker", { value: { ready: new Promise(() => {}) }, configurable: true });

      const done = vi.fn();
      const promise = unsubscribeThisDeviceFromPush().then(done);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(done).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

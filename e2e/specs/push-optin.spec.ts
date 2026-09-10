import { expect, test, type APIRequestContext } from "@playwright/test";

async function dispatcherAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "dispatcher@ronmacrae.example", password: "dispatch1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

/**
 * Covers the opt-in Web Push UI end to end EXCEPT the browser vendor's own push
 * service (Chrome/FCM etc.) — that's a third-party dependency outside this app's
 * code, isn't reachable/deterministic in a sandboxed test run, and isn't what this
 * app is responsible for. `navigator.serviceWorker.ready` is stubbed to a fake
 * registration whose `pushManager` never leaves the browser process (no real push
 * service call happens), but every request to /api/push/subscribe and
 * /api/push/unsubscribe below is real — this spec asserts on those actual network
 * responses, not just the resulting button text. (The deeper "is a row really
 * created/scoped correctly" proof is apps/api/test/push.test.ts, which reads the
 * database directly — that's the right layer for that assertion, not e2e.)
 */
test("rider can opt in and out of push notifications; the subscribe/unsubscribe calls really round-trip to the API", async ({ page, request }) => {
  await page.addInitScript(() => {
    // The permission prompt itself is the browser's own UI, not this app's code —
    // stub it granted rather than depend on headless-Chromium permission-grant
    // plumbing (unreliable in this environment; see the spec's docblock for the
    // scope boundary this whole init script draws).
    Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => "granted" });
    window.Notification.requestPermission = () => Promise.resolve("granted");

    const endpoint = `https://push.example.test/mock-${Math.random().toString(36).slice(2)}`;
    const makeSub = () => ({
      endpoint,
      toJSON: () => ({ endpoint, keys: { p256dh: "mock-p256dh", auth: "mock-auth" } }),
      unsubscribe: async () => {
        stored = null;
        return true;
      },
    });
    let stored: ReturnType<typeof makeSub> | null = null;
    const fakeRegistration = {
      pushManager: {
        getSubscription: async () => stored,
        subscribe: async () => {
          stored = makeSub();
          return stored;
        },
      },
    };
    Object.defineProperty(window.navigator.serviceWorker, "ready", { configurable: true, get: () => Promise.resolve(fakeRegistration) });
  });

  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18769${Date.now().toString().slice(-7)}`;
  const riderPassword = "pushOptIn1234";
  await request.post("/api/riders", { headers: auth, data: { name: "Push OptIn Rider", phone: uniquePhone, password: riderPassword } });

  await page.goto("/login");
  await page.getByLabel("Email or phone").fill(uniquePhone);
  await page.getByLabel("Password").fill(riderPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();

  const [subscribeResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes("/api/push/subscribe") && res.request().method() === "POST"),
    page.getByRole("button", { name: "Enable push notifications" }).click(),
  ]);
  expect(subscribeResponse.ok()).toBe(true);
  expect((await subscribeResponse.json()) as { ok: boolean }).toEqual({ ok: true });
  await expect(page.getByRole("button", { name: "Disable push notifications" })).toBeVisible();

  const [unsubscribeResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes("/api/push/unsubscribe") && res.request().method() === "POST"),
    page.getByRole("button", { name: "Disable push notifications" }).click(),
  ]);
  expect(unsubscribeResponse.ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Enable push notifications" })).toBeVisible();
});

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function adminAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "admin@ronmacrae.example", password: "admin1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

async function login(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Spec: "when an order comes in the dispatch [should] get a notification
 * the same [way a courier already gets pushed for a new offer]". Real-time
 * (WebSocket, this test) and push (dispatch-push.test.ts, at the API
 * layer — a browser vendor's actual push service isn't reachable in a
 * sandboxed test run, same scope boundary push-optin.spec.ts's own
 * docblock draws) are two separate, complementary signals; this covers
 * the one actually observable end to end in a real browser.
 */
test("a dispatcher already on the Jobs screen sees a live 'New order' alert the moment a public order lands, with a live list refresh", async ({ page, request }) => {
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();

  const auth = await adminAuth(request);
  const merchantRes = await request.post("/api/merchants", { headers: auth, data: { name: `Order Alert Merchant ${Date.now()}` } });
  const merchant = ((await merchantRes.json()) as { merchant: { slug: string } }).merchant;
  const orderRes = await request.post(`/api/order/${merchant.slug}`, {
    data: {
      name: "Order Alert Customer",
      phone: `876555${String(Math.floor(1000 + Math.random() * 9000))}`,
      addressText: "12 Alert Test Ave",
      items: [{ name: "Alert Test Parcel", quantity: 1, unitPrice: 1500 }],
    },
  });
  expect(orderRes.ok()).toBe(true);
  const order = (await orderRes.json()) as { jobNumber: string };

  await expect(page.getByText(new RegExp(`New order ${order.jobNumber}`))).toBeVisible({ timeout: 5_000 });
  // The Jobs list itself refreshes live too — not just a toast, the actual
  // row shows up without the dispatcher touching anything or waiting for
  // the 15s poll. (Not asserting an exact before/after row-count delta —
  // this business's job list is shared, persistent state across the whole
  // e2e run, so other specs' jobs legitimately come and go around this one.)
  await expect(page.getByRole("row", { name: order.jobNumber })).toBeVisible({ timeout: 5_000 });
});

test("a dispatcher can enable push notifications from the sidebar — same control a courier already had", async ({ page }) => {
  // Headless Chromium defaults Notification.permission to "denied" (no
  // real person to answer an OS prompt) — same stub push-optin.spec.ts
  // already uses so PushOptIn reaches its real "off" state instead of
  // the "blocked in your browser settings" one, which is a Chromium-test-
  // environment artifact, not anything this app's own code did.
  await page.addInitScript(() => {
    Object.defineProperty(window.Notification, "permission", { configurable: true, get: () => "default" });
  });
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  // Rendered in the desktop sidebar's own user/settings area, alongside
  // theme and sign-out — not tucked away on a page a dispatcher may never open.
  await expect(page.getByRole("button", { name: /push notifications/i })).toBeVisible({ timeout: 10_000 });
});

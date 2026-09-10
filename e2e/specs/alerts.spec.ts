import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function dispatcherAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "dispatcher@ronmacrae.example", password: "dispatch1234" } });
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
 * Direct assignment (POST /api/jobs/:id/assignments) must alert only the rider
 * it was assigned to — unlike a broadcast, which goes to every eligible rider.
 * This is frontend logic (alerts-toaster.tsx's isRider + source==="assign" check,
 * lib/realtime.tsx's matching unread-count rule), not just backend room-scoping,
 * so it needs its own coverage here rather than relying on the API-level offers
 * tests alone.
 */
test("direct assignment alerts and bumps unread only for the assigned rider, not an uninvolved one", async ({ request, browser }) => {
  const auth = await dispatcherAuth(request);
  const stamp = Date.now().toString().slice(-7);
  const assignedPhone = `+18772${stamp}`;
  const otherPhone = `+18773${stamp}`;
  const password = "alertsRider1234";

  const assignedRes = await request.post("/api/riders", { headers: auth, data: { name: "Assigned Rider", phone: assignedPhone, password } });
  const otherRes = await request.post("/api/riders", { headers: auth, data: { name: "Uninvolved Rider", phone: otherPhone, password } });
  const assignedRider = ((await assignedRes.json()) as { rider: { id: string } }).rider;
  const otherRider = ((await otherRes.json()) as { rider: { id: string } }).rider;
  // RidersService.create() sets every new rider to status "available" — so without
  // this, "Uninvolved Rider" would be eligible for any *other*, concurrently-running
  // spec's unscoped "broadcast to all eligible riders" (e.g. offers.spec.ts's UI
  // flow), and could pick up a real "offer" alert that has nothing to do with this
  // test, making the assertion below flaky for a reason unrelated to this feature.
  // Direct assignment itself doesn't require "available", so taking it offline here
  // doesn't weaken what this test is actually proving.
  await request.patch(`/api/riders/${otherRider.id}/status`, { headers: auth, data: { status: "offline" } });

  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: "Direct assignment alert test parcel" } });
  const job = (await created.json()) as { job: { id: string } };

  // Both riders have their dashboards open BEFORE the assignment happens.
  const assignedCtx = await browser.newContext();
  const otherCtx = await browser.newContext();
  const assignedPage = await assignedCtx.newPage();
  const otherPage = await otherCtx.newPage();
  await login(assignedPage, assignedPhone, password);
  await login(otherPage, otherPhone, password);
  await expect(assignedPage.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  await expect(otherPage.getByRole("heading", { name: "My deliveries" })).toBeVisible();

  const assignRes = await request.post(`/api/jobs/${job.job.id}/assignments`, { headers: auth, data: { riderId: assignedRider.id } });
  expect(assignRes.ok()).toBe(true);

  await expect(assignedPage.getByText(/You've been assigned/)).toBeVisible({ timeout: 5_000 });
  const assignedBadge = assignedPage.getByRole("link", { name: "Dashboard" }).getByText("1", { exact: true });
  await expect(assignedBadge).toBeVisible();

  // Give the "other" rider's socket the same window to have received (and wrongly
  // shown) something, then assert it never did.
  await otherPage.waitForTimeout(2_000);
  await expect(otherPage.getByText(/You've been assigned/)).not.toBeVisible();
  await expect(otherPage.getByRole("link", { name: "Dashboard" }).getByText("1", { exact: true })).not.toBeVisible();

  await assignedCtx.close();
  await otherCtx.close();
});

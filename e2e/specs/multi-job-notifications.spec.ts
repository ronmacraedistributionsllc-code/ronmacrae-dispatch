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

async function makeRider(request: APIRequestContext, auth: Record<string, string>, name: string, overrides: Record<string, unknown> = {}) {
  const phone = `+18779${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 9)}`;
  const password = "multiJobRider1234";
  const res = await request.post("/api/riders", { headers: auth, data: { name, phone, password, dailyCapacity: 2, ...overrides } });
  expect(res.ok()).toBe(true);
  const rider = ((await res.json()) as { rider: { id: string } }).rider;
  const statusRes = await request.patch(`/api/riders/${rider.id}/status`, { headers: auth, data: { status: "available" } });
  expect(statusRes.ok()).toBe(true);
  return { id: rider.id, phone, password };
}

/**
 * Proves the Stage 9/10 fix end-to-end, with two real (separately logged in)
 * rider browser sessions: a rider who is already carrying an active job still
 * gets a live offer card, toast and unread badge for a *new*, unrelated job —
 * the exact behavior that used to break (accepting one job silently made a
 * rider invisible to further broadcasts) — while a rider who has explicitly
 * marked themselves unavailable gets nothing at all from the same broadcast.
 */
test("a rider carrying a job still gets new offers live, while an unavailable rider gets none", async ({ page, request, browser }) => {
  const auth = await dispatcherAuth(request);
  const busyRider = await makeRider(request, auth, "Multi-Job Busy Rider");
  const unavailableRider = await makeRider(request, auth, "Multi-Job Unavailable Rider");

  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;

  // Give busyRider one active job up front (so they're carrying work, not idle).
  const firstJob = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: "Multi-job first parcel" } });
  const firstJobId = (await firstJob.json() as { job: { id: string } }).job.id;
  const assignRes = await request.post(`/api/jobs/${firstJobId}/assignments`, { headers: auth, data: { riderId: busyRider.id } });
  expect(assignRes.ok()).toBe(true);

  // The unavailable rider explicitly opts out of new work.
  const unavailableSet = await request.patch(`/api/riders/${unavailableRider.id}/status`, { headers: auth, data: { status: "unavailable" } });
  expect(unavailableSet.ok()).toBe(true);

  // Both riders' dashboards are open BEFORE the second job is broadcast.
  const busyCtx = await browser.newContext();
  const unavailableCtx = await browser.newContext();
  const busyPage = await busyCtx.newPage();
  const unavailablePage = await unavailableCtx.newPage();
  await login(busyPage, busyRider.phone, busyRider.password);
  await login(unavailablePage, unavailableRider.phone, unavailableRider.password);
  await expect(busyPage.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  await expect(unavailablePage.getByRole("heading", { name: "My deliveries" })).toBeVisible();

  // busyRider's dashboard shows the connection as live, and the one active job.
  await expect(busyPage.getByTestId("connection-status")).toContainText("Live", { timeout: 10_000 });
  await expect(busyPage.getByText("1 of 2 active job")).toBeVisible();
  // unavailableRider's own toggle reads "Unavailable", not disabled by having no jobs.
  await expect(unavailablePage.getByRole("button", { name: "Unavailable" })).toBeVisible();

  // Broadcast a second, unrelated job to both riders at once.
  const secondJob = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: "Multi-job second parcel — offer test" } });
  const secondJobId = (await secondJob.json() as { job: { id: string } }).job.id;
  const broadcastRes = await request.post(`/api/jobs/${secondJobId}/offers/broadcast`, {
    headers: auth,
    data: { riderIds: [busyRider.id, unavailableRider.id] },
  });
  expect(broadcastRes.ok()).toBe(true);

  // busyRider — despite already carrying a job — gets the new offer live: card,
  // and the unread badge increments (no reload, no waiting for the poll).
  await expect(busyPage.getByText("Multi-job second parcel — offer test")).toBeVisible({ timeout: 5_000 });
  await expect(busyPage.getByRole("heading", { name: "Job offers" })).toBeVisible();
  const busyBadge = busyPage.getByRole("link", { name: "Dashboard" }).getByText("1", { exact: true });
  await expect(busyBadge).toBeVisible();

  // unavailableRider gets nothing — give its socket the same window to have
  // (wrongly) received it, then assert it never did.
  await unavailablePage.waitForTimeout(2_000);
  await expect(unavailablePage.getByText("Multi-job second parcel — offer test")).not.toBeVisible();
  await expect(unavailablePage.getByRole("heading", { name: "Job offers" })).not.toBeVisible();

  // busyRider accepts the second offer too, going to exactly capacity (2/2), and
  // the dashboard reflects it without a reload. Scoped to the offer card itself —
  // the first job's own card also has an unrelated "Accept" action (advancing its
  // own status), so an unscoped locator here would be ambiguous.
  const secondOfferCard = busyPage.locator("section.card").filter({ hasText: "Multi-job second parcel — offer test" });
  await secondOfferCard.getByRole("button", { name: "Accept" }).click();
  await expect(busyPage.getByText("2 of 2 active job")).toBeVisible();
  await expect(busyPage.getByText("At capacity", { exact: true })).toBeVisible();

  await busyCtx.close();
  await unavailableCtx.close();
});

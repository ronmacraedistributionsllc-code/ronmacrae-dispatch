import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function login(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function dispatcherAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "dispatcher@ronmacrae.example", password: "dispatch1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

async function riderAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "+8765550001", password: "rider1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

test("rider sees only assigned delivery details and completes the PIN-protected flow", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const riders = ((await (await request.get("/api/riders", { headers: auth })).json()) as { riders: { id: string; name: string }[] }).riders;
  const customer = customers.find((entry) => entry.phone === "+8765551234")!;
  const rider = riders.find((entry) => entry.name === "Kei Bearer")!;
  const created = await request.post("/api/jobs", { headers: auth, data: {
    customerId: customer.id, pickupAddressText: "10 Duke Street", landmark: "Blue gate", itemSummary: "School shoes", itemColor: "Black", itemSize: "9", quantity: 2,
    fare: 6500, fee: 500, paymentMethod: "cod", scheduledAt: "2026-09-11T10:30:00.000Z", priority: "urgent", instructions: "Call at the gate",
  } });
  expect(created.ok()).toBe(true);
  const createdJob = (await created.json()) as { job: { id: string; jobNumber: string } };
  const jobId = createdJob.job.id;
  const assigned = await request.post(`/api/jobs/${jobId}/assignments`, { headers: auth, data: { riderId: rider.id } });
  expect(assigned.ok()).toBe(true);
  const detail = await request.get(`/api/jobs/${jobId}`, { headers: auth });
  const pin = ((await detail.json()) as { job: { pin: string } }).job.pin;

  await login(page, "+8765550001", "rider1234");
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: createdJob.job.jobNumber }) });
  await expect(card.getByText(customer.phone ?? "+8765551234")).toHaveCount(0); // no raw phone number on the rider card — in-app messaging only
  await expect(card.getByText("10 Duke Street")).toBeVisible();
  await expect(card.getByText("School shoes")).toBeVisible();
  await expect(card.getByText("Black")).toBeVisible();
  // Urgent priority is now shown as a prominent badge, not a plain "Priority" field.
  await expect(card.getByText("Urgent", { exact: true })).toBeVisible();

  // Step 0 (separate from collection): Accept, via the job-specific
  // confirmation sheet — not a bare, unconfirmed tap.
  await card.getByRole("button", { name: "Accept job" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(createdJob.job.jobNumber)).toBeVisible();
  await sheet.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(sheet).not.toBeVisible();
  await expect(card.getByText("accepted")).toBeVisible();
  // Acceptance never silently advances further — still needs an explicit collect.
  await expect(card.getByRole("button", { name: "Confirm collection" })).toBeVisible();

  // Step 1: Collected (the popup asks the rider to confirm the right package).
  await card.getByRole("button", { name: "Confirm collection" }).click();
  await expect(sheet.getByText(/correct package/i)).toBeVisible();
  await sheet.getByRole("button", { name: "Yes, mark collected" }).click();
  await expect(card.getByText("picked up")).toBeVisible();

  // Step 2: In transit.
  await card.getByRole("button", { name: "Start delivery" }).click();
  await sheet.getByRole("button", { name: "Start delivery", exact: true }).click();
  await expect(card.getByText("in transit")).toBeVisible();

  // A rider double-tapping the same primary action (e.g. a slow connection,
  // tapping again before the first request returns) must not silently apply
  // twice — the backend's duplicate-submit guard is exercised directly here
  // since the UI already disables the button once pending.
  const riderHeaders = await riderAuth(request);
  const [dup1, dup2] = await Promise.all([
    request.post(`/api/bearer/jobs/${jobId}/transition`, { headers: riderHeaders, data: { to: "delivered", pin } }),
    request.post(`/api/bearer/jobs/${jobId}/transition`, { headers: riderHeaders, data: { to: "delivered", pin } }),
  ]);
  expect([dup1.status(), dup2.status()].sort()).toEqual([200, 409]);
  await page.reload();

  const finalDetail = (await (await request.get(`/api/jobs/${jobId}`, { headers: await dispatcherAuth(request) })).json()) as { job: { status: string } };
  expect(finalDetail.job.status).toBe("delivered");

  // A delivered job moves into the separate completed-history section — not
  // mixed in with the still-active "To pick up" / "In my possession" cards.
  await expect(page.locator("section.card").filter({ has: page.getByRole("heading", { name: createdJob.job.jobNumber }) })).toHaveCount(0);
  await page.getByText(/Completed history/).click();
  await expect(page.getByText(createdJob.job.jobNumber)).toBeVisible();
});

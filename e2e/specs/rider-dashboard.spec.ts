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
  await expect(card.getByText("+8765551234")).toBeVisible();
  await expect(card.getByText("10 Duke Street")).toBeVisible();
  await expect(card.getByText("School shoes")).toBeVisible();
  await expect(card.getByText("Black")).toBeVisible();
  await expect(card.getByText("Priority").locator("..").getByText("urgent", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Accept" }).click();
  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByRole("button", { name: "Heading to Pickup" })).toBeVisible();

  // Advance through the remaining API workflow as the same rider, then use
  // the browser to prove the delivery PIN gate on the final action.
  const riderHeaders = await riderAuth(request);
  for (const body of [
    { stage: "heading_to_pickup" }, { stage: "at_pickup" },
  ]) expect((await request.post(`/api/bearer/jobs/${jobId}/stage`, { headers: riderHeaders, data: body })).ok()).toBe(true);
  for (const to of ["picked_up", "in_transit", "delivering"]) expect((await request.post(`/api/bearer/jobs/${jobId}/transition`, { headers: riderHeaders, data: { to } })).ok()).toBe(true);
  await page.reload();
  await card.getByRole("button", { name: "Delivered" }).click();
  await card.getByLabel("Delivery PIN").fill(pin);
  await card.getByLabel("Proof / action notes").fill("Delivered at customer gate");
  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByRole("button", { name: "Confirm" })).not.toBeVisible();
  await expect(card.locator("p").filter({ hasText: "delivered ·" })).toBeVisible();
});

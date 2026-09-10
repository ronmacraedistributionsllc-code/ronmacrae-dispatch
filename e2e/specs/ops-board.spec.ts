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

test("dispatcher operations board shows rider load, a waiting offer, an overdue job, and a stale-location warning — never a fabricated current position", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18781${Date.now().toString().slice(-7)}`;

  const riderRes = await request.post("/api/riders", { headers: auth, data: { name: "Ops Board E2E Rider", phone: uniquePhone, dailyCapacity: 2 } });
  const rider = ((await riderRes.json()) as { rider: { id: string } }).rider;
  await request.patch(`/api/riders/${rider.id}/status`, { headers: auth, data: { status: "available" } });

  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;

  // An active job, overdue (promisedAt in the past), assigned to this rider.
  const overdueLabel = `Ops overdue ${Date.now()}`;
  const created = await request.post("/api/jobs", {
    headers: auth,
    data: { customerId: customer.id, itemSummary: overdueLabel, promisedAt: new Date(Date.now() - 45 * 60_000).toISOString() },
  });
  const createdJob = (await created.json()) as { job: { id: string; jobNumber: string | null } };
  const overdueJobNumber = createdJob.job.jobNumber ?? createdJob.job.id.slice(0, 8);
  await request.post(`/api/jobs/${createdJob.job.id}/assignments`, { headers: auth, data: { riderId: rider.id } });

  // A waiting offer for a second job.
  const offerJob = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: `Ops offer ${Date.now()}`, priority: "urgent" } });
  const offerJobBody = (await offerJob.json()) as { job: { id: string; jobNumber: string | null } };
  const offerJobNumber = offerJobBody.job.jobNumber ?? offerJobBody.job.id.slice(0, 8);
  await request.post(`/api/jobs/${offerJobBody.job.id}/offers/broadcast`, { headers: auth, data: { riderIds: [rider.id] } });

  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/ops");
  await expect(page.getByRole("heading", { name: "Operations board" })).toBeVisible();

  const riderRow = page.getByTestId(`ops-rider-row-${rider.id}`);
  await expect(riderRow).toBeVisible();
  await expect(riderRow).toContainText("1 / 2"); // one active job, capacity 2
  await expect(riderRow.getByText("No report yet")).toBeVisible(); // honest — never a fabricated position

  // Counts aren't asserted exactly — the board is system-wide and this db is
  // shared with other specs — but this run's own rows must be present.
  await expect(page.getByRole("heading", { name: /Waiting offers/ })).toBeVisible();
  await expect(page.getByText(`${offerJobNumber} → Ops Board E2E Rider`)).toBeVisible();

  const overdueRow = page.locator("section").filter({ has: page.getByRole("heading", { name: /Overdue jobs/ }) }).locator("li").filter({ hasText: overdueJobNumber });
  await expect(overdueRow).toBeVisible();
  await expect(overdueRow.getByText(/overdue$/)).toBeVisible();

  // Expand the rider's route queue inline from the board.
  await riderRow.getByRole("button", { name: "Route queue" }).click();
  const queuePanel = page.getByTestId(`ops-queue-${rider.id}`);
  await expect(queuePanel).toBeVisible();
  await expect(queuePanel.getByText(overdueLabel)).toBeVisible();
  await expect(queuePanel.getByRole("button", { name: "Move up" })).not.toBeVisible();
});

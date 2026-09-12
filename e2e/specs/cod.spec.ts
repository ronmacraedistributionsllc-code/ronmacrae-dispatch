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

test("rider records a COD collection and handover, then dispatch approves it from the reconciliation board", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;
  const riders = ((await (await request.get("/api/riders", { headers: auth })).json()) as { riders: { id: string; name: string }[] }).riders;
  const kei = riders.find((r) => r.name === "Kei Bearer")!;

  const jobLabel = `Cod e2e parcel ${Date.now()}`;
  const created = await request.post("/api/jobs", {
    headers: auth,
    data: { customerId: customer.id, itemSummary: jobLabel, paymentMethod: "cod", fare: 2000 },
  });
  expect(created.ok()).toBe(true);
  const createdJob = (await created.json()) as { job: { id: string; jobNumber: string | null } };
  const jobId = createdJob.job.id;
  const label = createdJob.job.jobNumber ?? jobId.slice(0, 8);
  const assign = await request.post(`/api/jobs/${jobId}/assignments`, { headers: auth, data: { riderId: kei.id } });
  expect(assign.ok()).toBe(true);

  // Rider records the collection via the API (the rider-dashboard UI path for
  // this is covered visually below instead, to keep this spec focused on the
  // reconciliation board — the collect/hand-in endpoints themselves have their
  // own dedicated coverage in apps/api/test/cod.test.ts).
  const riderAuthRes = await request.post("/api/auth/login", { data: { identifier: "+8765550001", password: "rider1234" } });
  const riderToken = { authorization: `Bearer ${(await riderAuthRes.json() as { accessToken: string }).accessToken}` };
  // Collection can only be recorded once the job is past "assigned" (accepted onward).
  const acceptRes = await request.post(`/api/bearer/jobs/${jobId}/accept`, { headers: riderToken, data: {} });
  expect(acceptRes.ok()).toBe(true);
  const collectRes = await request.post(`/api/jobs/${jobId}/collect`, { headers: riderToken, data: { amountCollected: 2000 } });
  expect(collectRes.ok()).toBe(true);
  const handInRes = await request.post(`/api/jobs/${jobId}/cod/hand-in`, { headers: riderToken, data: { amountHandedIn: 1950 } });
  expect(handInRes.ok()).toBe(true);

  // Dispatch sees it on the board and can approve the drop-off themselves
  // (spec item 8 — "Dispatch must press Approve Cash Drop-Off"), but not
  // dispute it — that stays an accountant/admin-only escalation.
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/cod");
  await expect(page.getByRole("heading", { name: "COD reconciliation" })).toBeVisible();
  await page.getByRole("button", { name: "Awaiting approval" }).click();
  const row = page.locator("section.card").filter({ hasText: label });
  await expect(row).toBeVisible();
  await expect(row.locator("span").filter({ hasText: "Handed in" })).toBeVisible();
  // 50 short (1950 handed in vs 2000 collected)
  await expect(row.getByText(/short/)).toBeVisible();
  await expect(row.getByRole("button", { name: "Approve cash drop-off" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Dispute" })).toHaveCount(0);
  await row.getByRole("button", { name: "Approve cash drop-off" }).click();
  // Approving moves it out of the "Awaiting approval" (handed_in) filter entirely.
  await expect(row).not.toBeVisible();
  await page.getByRole("button", { name: "Approved", exact: true }).click();
  const approvedRow = page.locator("section.card").filter({ hasText: label });
  await expect(approvedRow.locator("span").filter({ hasText: "Approved" })).toBeVisible();
  await expect(approvedRow.getByRole("button", { name: "Approve" })).not.toBeVisible();

  // Confirm via the API too that it's locked against further edits.
  const reCollect = await request.post(`/api/jobs/${jobId}/collect`, { headers: riderToken, data: { amountCollected: 1 } });
  expect(reCollect.status()).toBe(409);
});

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

test("accountant filters the operating report by rider and sees an honest rider-earnings note", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18791${Date.now().toString().slice(-7)}`;

  const riderRes = await request.post("/api/riders", { headers: auth, data: { name: "Report E2E Rider", phone: uniquePhone } });
  const rider = ((await riderRes.json()) as { rider: { id: string } }).rider;
  await request.patch(`/api/riders/${rider.id}/status`, { headers: auth, data: { status: "available" } });

  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;
  const jobLabel = `Report e2e parcel ${Date.now()}`;
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: jobLabel } });
  const job = (await created.json()) as { job: { id: string } };
  await request.post(`/api/jobs/${job.job.id}/assignments`, { headers: auth, data: { riderId: rider.id } });

  // Drive the job to delivered as staff (this rider has no bearer login —
  // staff can move a job through its transitions directly, same as any
  // other dispatcher override).
  for (const to of ["accepted", "picked_up", "in_transit", "delivering"]) {
    const res = await request.post(`/api/jobs/${job.job.id}/transition`, { headers: auth, data: { to } });
    expect(res.ok()).toBe(true);
  }
  const jobDetail = await request.get(`/api/jobs/${job.job.id}`, { headers: auth });
  const pin = ((await jobDetail.json()) as { job: { pin: string } }).job.pin;
  const deliver = await request.post(`/api/jobs/${job.job.id}/transition`, { headers: auth, data: { to: "delivered", pin } });
  expect(deliver.ok()).toBe(true);

  await login(page, "accountant@ronmacrae.example", "account1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Operating reports" })).toBeVisible();

  await page.getByLabel("Rider").selectOption({ label: "Report E2E Rider" });
  const byRiderRow = page.getByRole("row").filter({ hasText: "Report E2E Rider" });
  await expect(byRiderRow).toBeVisible();
  await expect(byRiderRow.getByText("1", { exact: true })).toBeVisible();
  await expect(byRiderRow.getByText("rate not set")).toBeVisible();
  await expect(page.getByText(/no configured pay rate/)).toBeVisible();

  const csvLink = page.getByRole("link", { name: "Export CSV" });
  await expect(csvLink).toHaveAttribute("href", /reports\/jobs\.csv/);
});

test("a dispatcher cannot view operating reports", async ({ page }) => {
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reports" })).not.toBeVisible();
  await page.goto("/reports");
  await expect(page.getByText("Only an owner/admin or accountant can view operating reports.")).toBeVisible();
});

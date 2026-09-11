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
 * Rider cash-profile corrections (Stage 27 / spec 9) — a fresh rider (not
 * the shared "Kei Bearer" used elsewhere in this suite, which already
 * carries other tests' own COD history) so the figures asserted here are
 * exact, not just "at least."
 */
test("a rider's cash summary and the dispatcher's ops-board cash panel both show the real collected/handed-in figures", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18782${Date.now().toString().slice(-7)}`;
  const riderPassword = "e2eCashRider1";
  const riderRes = await request.post("/api/riders", { headers: auth, data: { name: "Cash E2E Rider", phone: uniquePhone, password: riderPassword, dailyCapacity: 5 } });
  const rider = ((await riderRes.json()) as { rider: { id: string; userId: string | null } }).rider;

  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;

  const created = await request.post("/api/jobs", {
    headers: auth,
    data: { customerId: customer.id, itemSummary: `Cash e2e parcel ${Date.now()}`, paymentMethod: "cod", fare: 3000 },
  });
  const createdJob = (await created.json()) as { job: { id: string } };
  const jobId = createdJob.job.id;
  await request.post(`/api/jobs/${jobId}/assignments`, { headers: auth, data: { riderId: rider.id } });

  // A rider only gets a login-capable account when a password is supplied
  // at creation (see riders.ts) — passed above, same as this suite's other
  // specs that need to authenticate as a rider they just created.
  const riderAuthRes = await request.post("/api/auth/login", { data: { identifier: uniquePhone, password: riderPassword } });
  expect(riderAuthRes.ok()).toBe(true);
  const riderAuth = { authorization: `Bearer ${(await riderAuthRes.json() as { accessToken: string }).accessToken}` };

  await request.post(`/api/bearer/jobs/${jobId}/accept`, { headers: riderAuth, data: {} });
  await request.post(`/api/jobs/${jobId}/collect`, { headers: riderAuth, data: { amountCollected: 3000 } });
  await request.post(`/api/jobs/${jobId}/cod/hand-in`, { headers: riderAuth, data: { amountHandedIn: 2900 } });

  // Dispatcher's ops-board cash panel.
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/ops");
  const row = page.getByTestId(`ops-rider-row-${rider.id}`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Cash" }).click();
  const cashPanel = page.getByTestId(`ops-cash-${rider.id}`);
  await expect(cashPanel.getByText("J$2,900")).toBeVisible(); // handed in, unconfirmed
  await expect(cashPanel.getByText(/Shortage/)).toBeVisible(); // 3000 collected, 2900 handed in

  // Rider's own dashboard shows the same collected figures.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, uniquePhone, riderPassword);
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  const riderCashSummary = page.getByTestId("rider-cash-summary");
  await riderCashSummary.getByText("Cash summary").click();
  await expect(riderCashSummary.getByText("J$2,900")).toBeVisible();
});

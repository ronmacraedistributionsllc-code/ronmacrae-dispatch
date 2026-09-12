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

// A dedicated rider (not the shared seeded "Kei Bearer") so this spec's broadcast
// eligibility (requires rider.status === "available") can't be raced by another spec
// file putting the seeded rider on a job in a parallel worker.
test("dispatcher broadcasts an offer and the rider accepts it from their dashboard", async ({ page, request, browser }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18765${Date.now().toString().slice(-7)}`;
  const riderPassword = "offerRider1234";

  const riderRes = await request.post("/api/riders", {
    headers: auth,
    data: { name: "Offer Test Rider", phone: uniquePhone, password: riderPassword, dailyCapacity: 3 },
  });
  expect(riderRes.ok()).toBe(true);
  const rider = ((await riderRes.json()) as { rider: { id: string } }).rider;
  const statusRes = await request.patch(`/api/riders/${rider.id}/status`, { headers: auth, data: { status: "available" } });
  expect(statusRes.ok()).toBe(true);

  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234");
  expect(customer).toBeTruthy();
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId: customer!.id, itemSummary: "Offer flow test parcel" } });
  expect(created.ok()).toBe(true);
  const job = (await created.json()) as { job: { id: string; jobNumber: string | null } };
  const label = job.job.jobNumber ?? job.job.id.slice(0, 8);

  // --- dispatcher UI: broadcast an offer ---
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/jobs");
  const row = page.getByRole("row", { name: label });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Offers" }).click();
  // Scoped by data-testid: the accumulated dev db has many other `new` jobs whose
  // rider-picker <option>s also read "Offer Test Rider", so an unscoped text locator
  // would be ambiguous.
  const offersPanel = page.getByTestId(`offers-panel-${job.job.id}`);
  await offersPanel.getByRole("button", { name: "Broadcast to available riders" }).click();
  // The accumulated dev db can have other, stale "Offer Test Rider"-named riders left
  // over from earlier interrupted runs (same display name, different ids) also eligible
  // for this broadcast — scope by this run's own rider id, not by display text.
  const myOffer = offersPanel.getByTestId(`offer-rider-${rider.id}`);
  await expect(myOffer).toBeVisible();
  await expect(myOffer.getByText("open", { exact: true })).toBeVisible();

  // --- rider UI (separate browser context — a different login session): accept it ---
  const riderContext = await browser.newContext();
  const riderPage = await riderContext.newPage();
  await login(riderPage, uniquePhone, riderPassword);
  await expect(riderPage.getByRole("heading", { name: "Available jobs" })).toBeVisible();
  const offerCard = riderPage.locator("section.card").filter({ hasText: "Offer flow test parcel" });
  await expect(offerCard).toBeVisible();
  await offerCard.getByRole("button", { name: "Accept" }).click();
  // The "Available jobs" section itself stays visible (always-shown, with a
  // count) and the accepted job's card keeps the same item-summary text —
  // so the real signal that the *offer* is gone (not just any card with
  // this text) is that there's no more "Decline" button anywhere: only an
  // open offer card renders one.
  await expect(riderPage.getByRole("button", { name: "Decline" })).toHaveCount(0);
  await expect(riderPage.getByRole("heading", { name: label })).toBeVisible();
  await riderContext.close();

  // --- back on the dispatcher Jobs screen: the job is now the new rider's, and
  //     already `accepted` — accepting the offer IS the rider's one accept
  //     step (spec item 1), so there's no separate `assigned`-awaiting-accept
  //     state to pass through for this path (unlike a direct dispatcher assign).
  await page.reload();
  const assignedRow = page.getByRole("row", { name: label });
  await expect(assignedRow.getByText("accepted", { exact: true })).toBeVisible();
  await expect(assignedRow.getByText("Offer Test Rider", { exact: true })).toBeVisible();
});

test("a withdrawn offer disappears from the rider's dashboard", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18766${Date.now().toString().slice(-7)}`;
  const riderPassword = "offerRider1234";

  const riderRes = await request.post("/api/riders", {
    headers: auth,
    data: { name: "Withdraw Test Rider", phone: uniquePhone, password: riderPassword, dailyCapacity: 3 },
  });
  const rider = ((await riderRes.json()) as { rider: { id: string } }).rider;
  await request.patch(`/api/riders/${rider.id}/status`, { headers: auth, data: { status: "available" } });

  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: "Withdraw flow test parcel" } });
  const job = (await created.json()) as { job: { id: string; jobNumber: string | null } };

  const broadcastRes = await request.post(`/api/jobs/${job.job.id}/offers/broadcast`, { headers: auth, data: { riderIds: [rider.id] } });
  expect(broadcastRes.ok()).toBe(true);
  const { offers } = (await broadcastRes.json()) as { offers: { id: string }[] };
  expect(offers).toHaveLength(1);
  const withdrawRes = await request.post(`/api/offers/${offers[0]!.id}/withdraw`, { headers: auth, data: {} });
  expect(withdrawRes.ok()).toBe(true);

  await login(page, uniquePhone, riderPassword);
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  await expect(page.getByText("Withdraw flow test parcel")).not.toBeVisible();
});

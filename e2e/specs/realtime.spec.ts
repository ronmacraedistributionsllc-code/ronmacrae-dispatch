import { expect, test, type APIRequestContext } from "@playwright/test";

async function dispatcherAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "dispatcher@ronmacrae.example", password: "dispatch1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

/**
 * Proves the realtime websocket path actually delivers, rather than the rider's
 * page just happening to poll at the right moment: the rider's dashboard is opened
 * (and has finished its first poll) *before* the offer is created, and the
 * assertion below uses a tight timeout well under the 20s poll interval — a poll
 * landing inside that window would be a ~1-in-4 coincidence at best, not a
 * plausible explanation for every run passing.
 */
test("a rider's already-open dashboard shows a new offer live, without a page reload or waiting for its poll interval", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18767${Date.now().toString().slice(-7)}`;
  const riderPassword = "realtimeRider1234";

  const riderRes = await request.post("/api/riders", {
    headers: auth,
    data: { name: "Realtime Test Rider", phone: uniquePhone, password: riderPassword, dailyCapacity: 3 },
  });
  expect(riderRes.ok()).toBe(true);
  const rider = ((await riderRes.json()) as { rider: { id: string } }).rider;
  await request.patch(`/api/riders/${rider.id}/status`, { headers: auth, data: { status: "available" } });

  // Open the rider's dashboard FIRST, well before any offer exists.
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill(uniquePhone);
  await page.getByLabel("Password").fill(riderPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  // The "Job offers" section is always shown (with a count); nothing has
  // been broadcast yet, so it should read as empty.
  await expect(page.getByText("No offers waiting right now")).toBeVisible();

  // Now (only after the page is already sitting there) broadcast an offer.
  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: "Realtime push test parcel" } });
  expect(created.ok()).toBe(true);
  const job = (await created.json()) as { job: { id: string } };
  const broadcastRes = await request.post(`/api/jobs/${job.job.id}/offers/broadcast`, { headers: auth, data: { riderIds: [rider.id] } });
  expect(broadcastRes.ok()).toBe(true);

  // Tight timeout: the poll interval is 20s, so this only passes if the websocket
  // push actually fired.
  await expect(page.getByText("Realtime push test parcel")).toBeVisible({ timeout: 5_000 });
});

test("a dispatcher's open offers panel updates live when a rider accepts, without a manual refresh", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18768${Date.now().toString().slice(-7)}`;
  const riderPassword = "realtimeRider1234";

  const riderRes = await request.post("/api/riders", {
    headers: auth,
    data: { name: "Realtime Accept Rider", phone: uniquePhone, password: riderPassword, dailyCapacity: 3 },
  });
  const rider = ((await riderRes.json()) as { rider: { id: string } }).rider;
  await request.patch(`/api/riders/${rider.id}/status`, { headers: auth, data: { status: "available" } });

  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: "Realtime accept test parcel" } });
  const job = (await created.json()) as { job: { id: string; jobNumber: string | null } };
  const label = job.job.jobNumber ?? job.job.id.slice(0, 8);
  const broadcastRes = await request.post(`/api/jobs/${job.job.id}/offers/broadcast`, { headers: auth, data: { riderIds: [rider.id] } });
  const { offers } = (await broadcastRes.json()) as { offers: { id: string }[] };

  // Dispatcher opens the Jobs screen and expands this job's offers panel BEFORE
  // the rider accepts.
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill("dispatcher@ronmacrae.example");
  await page.getByLabel("Password").fill("dispatch1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/jobs");
  const row = page.getByRole("row", { name: label });
  await row.getByRole("button", { name: "Offers" }).click();
  const offersPanel = page.getByTestId(`offers-panel-${job.job.id}`);
  await expect(offersPanel.getByTestId(`offer-rider-${rider.id}`).getByText("open", { exact: true })).toBeVisible();

  // Accept via the API as the rider (the offers.spec.ts flow already covers the
  // full rider-UI accept path — this spec's focus is the dispatcher panel going
  // live, not re-proving the rider UI).
  const riderLogin = await request.post("/api/auth/login", { data: { identifier: uniquePhone, password: riderPassword } });
  const riderAuth = { authorization: `Bearer ${((await riderLogin.json()) as { accessToken: string }).accessToken}` };
  const acceptRes = await request.post(`/api/bearer/offers/${offers[0]!.id}/accept`, { headers: riderAuth });
  expect(acceptRes.ok()).toBe(true);

  await expect(offersPanel.getByTestId(`offer-rider-${rider.id}`).getByText("accepted", { exact: true })).toBeVisible({ timeout: 5_000 });
});

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

test("rider reorders their route queue, a dispatcher can view it read-only, and neither reorders on its own", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18780${Date.now().toString().slice(-7)}`;
  const riderPassword = "queueRider1234";

  const riderRes = await request.post("/api/riders", { headers: auth, data: { name: "Queue Test Rider", phone: uniquePhone, password: riderPassword, dailyCapacity: 3 } });
  const rider = ((await riderRes.json()) as { rider: { id: string } }).rider;
  await request.patch(`/api/riders/${rider.id}/status`, { headers: auth, data: { status: "available" } });

  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;

  const stamp = Date.now();
  const labels: string[] = [];
  const jobNumbers: string[] = [];
  for (const suffix of ["First stop", "Second stop"]) {
    const label = `${suffix} ${stamp}`;
    labels.push(label);
    const created = await request.post("/api/jobs", {
      headers: auth,
      data: {
        customerId: customer.id,
        itemSummary: label,
        pickupAddressText: "15-17 Half Way Tree Road, Kingston, Jamaica",
        pickupPoint: { lat: 18.0125, lng: -76.7875 },
        addressText: "10 Duke Street, Kingston, Jamaica",
        point: { lat: 17.98, lng: -76.79 },
      },
    });
    const createdJob = (await created.json()) as { job: { id: string; jobNumber: string | null } };
    jobNumbers.push(createdJob.job.jobNumber ?? createdJob.job.id.slice(0, 8));
    await request.post(`/api/jobs/${createdJob.job.id}/assignments`, { headers: auth, data: { riderId: rider.id } });
  }

  // Rider logs in, sees both in their route queue (no manual order set yet, so
  // by request time — "First stop" was created first).
  await login(page, uniquePhone, riderPassword);
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Route queue" })).toBeVisible();
  const queueSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Route queue" }) });
  const rows = queueSection.locator("ol > li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(labels[0]!);
  await expect(rows.nth(1)).toContainText(labels[1]!);

  // Reorder: move the second stop up. This is one explicit tap — nothing else
  // in the app is allowed to silently rearrange this list on its own.
  await rows.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(rows.nth(0)).toContainText(labels[1]!);
  await expect(rows.nth(1)).toContainText(labels[0]!);

  // Every stop offers a real "Open in Maps" handoff, not an in-app distance/ETA claim.
  await expect(rows.nth(0).getByRole("link", { name: "Open in Maps" })).toHaveAttribute("href", /google\.com\/maps\/dir/);

  // Reloading confirms the new order was actually persisted, not just local state.
  await page.reload();
  const rowsAfterReload = page.locator("section").filter({ has: page.getByRole("heading", { name: "Route queue" }) }).locator("ol > li");
  await expect(rowsAfterReload.nth(0)).toContainText(labels[1]!);
  await expect(rowsAfterReload.nth(1)).toContainText(labels[0]!);

  // Dispatcher can view the same rider's queue, read-only (no reorder controls).
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/jobs");
  const row = page.getByRole("row", { name: jobNumbers[1]! });
  await row.getByRole("button", { name: "Route queue" }).click();
  const dispatcherQueue = page.getByTestId(`queue-panel-${rider.id}`);
  await expect(dispatcherQueue).toBeVisible();
  await expect(dispatcherQueue.getByText(labels[1]!)).toBeVisible();
  await expect(dispatcherQueue.getByRole("button", { name: "Move up" })).not.toBeVisible();
  await expect(dispatcherQueue.getByRole("button", { name: "Move down" })).not.toBeVisible();
});

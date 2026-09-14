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

test("a new order automatically queues a customer notification, shown with a friendly status label", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const customerPhone = `+18790${Date.now().toString().slice(-7)}`;

  const customerRes = await request.post("/api/customers", { headers: auth, data: { name: "Notif E2E Customer", phone: customerPhone } });
  expect(customerRes.ok()).toBe(true);
  const customer = (await customerRes.json()) as { customer: { id: string; consentTracking: boolean } };
  // New customers get delivery-tracking messages by default (not marketing).
  expect(customer.customer.consentTracking).toBe(true);

  const jobLabel = `Notif e2e parcel ${Date.now()}`;
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.customer.id, itemSummary: jobLabel } });
  expect(created.ok()).toBe(true);
  const job = (await created.json()) as { job: { id: string } };
  const linkRes = await request.post(`/api/jobs/${job.job.id}/tracking-link`, { headers: auth });
  expect(linkRes.ok()).toBe(true);

  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();

  const row = page.getByRole("row").filter({ hasText: customerPhone });
  await expect(row).toBeVisible();
  // The template column shows a friendly label ("order confirmed"), not the
  // raw underscored key ("order_confirmed") — same "friendly, not raw"
  // treatment as the status column just below.
  await expect(row).toContainText("order confirmed");
  // Preview mode (memory provider): the friendly label is "Delivered", not the
  // raw enum value — and definitely not left showing "queued"/"sending".
  await expect(row.getByText(/^(Pending|Sent|Delivered)$/)).toBeVisible();
});

test("only an admin can edit message templates; a dispatcher sees them read-only", async ({ page }) => {
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/notifications");
  await page.getByRole("button", { name: "Message templates" }).click();
  await expect(page.getByText("heading to pickup")).toBeVisible();
  await expect(page.getByText("near destination")).toBeVisible();
  await expect(page.getByText("Only an owner/admin can edit templates.").first()).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, "admin@ronmacrae.example", "admin1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/notifications");
  await page.getByRole("button", { name: "Message templates" }).click();
  const deliveredBox = page.locator("textarea").nth(0);
  await expect(deliveredBox).toBeEditable();
});

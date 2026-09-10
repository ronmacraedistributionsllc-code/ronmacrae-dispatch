import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function loginAsDispatcher(page: Page, request: APIRequestContext): Promise<Record<string, string>> {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill("dispatcher@ronmacrae.example");
  await page.getByLabel("Password").fill("dispatch1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

  const res = await request.post("/api/auth/login", {
    data: { identifier: "dispatcher@ronmacrae.example", password: "dispatch1234" },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

test("dispatcher assigns a rider to a job from the Jobs screen", async ({ page, request }) => {
  const auth = await loginAsDispatcher(page, request);

  // setup: find the seeded customer and create a job through the API
  const custRes = await request.get("/api/customers", { headers: auth });
  expect(custRes.ok()).toBe(true);
  const customers = ((await custRes.json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234");
  expect(customer).toBeTruthy();

  const created = await request.post("/api/jobs", {
    headers: auth,
    data: { customerId: customer!.id, itemSummary: "1x pizza, large" },
  });
  expect(created.ok()).toBe(true);
  const job = (await created.json()) as { job: { id: string; jobNumber: string | null } };
  const label = job.job.jobNumber ?? job.job.id.slice(0, 8);

  await page.goto("/jobs");
  const row = page.getByRole("row", { name: label });
  await expect(row).toBeVisible();
  await expect(row.getByText("new", { exact: true })).toBeVisible();
  await expect(row.getByText("—")).toBeVisible();

  // assign the seeded rider
  // The rider dashboard flow can legitimately move Kei to on_job in a parallel
  // browser worker, and the disposable dev db accumulates other test riders across
  // sessions (some alphabetically before "Kei Bearer") — so neither a fixed option
  // index nor an exact full-label match (which also embeds the transient status
  // suffix) is reliable. Find the <option> by its rider-name prefix and select by
  // its value instead.
  const riderSelect = row.getByRole("combobox").first();
  const keiOption = riderSelect.locator("option", { hasText: "Kei Bearer" });
  const keiRiderId = await keiOption.getAttribute("value");
  expect(keiRiderId).toBeTruthy();
  await riderSelect.selectOption(keiRiderId!);
  await row.getByRole("button", { name: "Assign" }).click();
  await expect(row.getByText("assigned", { exact: true })).toBeVisible();
  await expect(row.getByText("Kei Bearer", { exact: true })).toBeVisible();

  // unassign returns the job to new with no rider
  await row.getByRole("button", { name: "Unassign" }).click();
  await expect(row.getByText("new", { exact: true })).toBeVisible();
  await expect(row.getByText("—")).toBeVisible();

  // and the status move control can close it out
  await row.getByRole("combobox").last().selectOption({ label: "cancelled" });
  await row.getByRole("button", { name: "Move" }).click();
  await expect(row.getByText("cancelled", { exact: true })).toBeVisible();
});

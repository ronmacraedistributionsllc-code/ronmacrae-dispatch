import { expect, test, type APIRequestContext } from "@playwright/test";

async function dispatcherAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "dispatcher@ronmacrae.example", password: "dispatch1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

test("dispatcher deletes an order from the Jobs screen, finds it in Trash, and restores it", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string }[] }).customers;
  const customerId = customers[0]!.id;

  const jobLabel = `Trash e2e parcel ${Date.now()}`;
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId, itemSummary: jobLabel, addressText: "1 Trash Test Lane" } });
  const createdJob = (await created.json()) as { job: { id: string; jobNumber: string | null } };
  const jobNumber = createdJob.job.jobNumber ?? createdJob.job.id.slice(0, 8);

  await page.goto("/login");
  await page.getByLabel("Email or phone").fill("dispatcher@ronmacrae.example");
  await page.getByLabel("Password").fill("dispatch1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

  await page.goto("/jobs");
  const row = page.getByRole("row", { name: jobNumber });
  await expect(row).toBeVisible();

  // window.confirm(...) then window.prompt(...), one after another — a
  // single listener that tells them apart by type, since two separately
  // registered `once` handlers would both race the same first dialog.
  page.on("dialog", (dialog) => {
    void (dialog.type() === "confirm" ? dialog.accept() : dialog.accept("cleaning up an e2e test order"));
  });
  await row.getByRole("button", { name: "Delete" }).click();

  await expect(page.getByRole("row", { name: jobNumber })).toHaveCount(0);

  await page.goto("/trash");
  await expect(page.getByText(jobNumber)).toBeVisible();
  await expect(page.getByText(/cleaning up an e2e test order/)).toBeVisible();
  await expect(page.getByText(/30 days left/)).toBeVisible();

  const trashRow = page.getByTestId(`trash-row-${createdJob.job.id}`);
  await trashRow.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId(`trash-row-${createdJob.job.id}`)).toHaveCount(0);

  await page.goto("/jobs");
  await expect(page.getByRole("row", { name: jobNumber })).toBeVisible();
});

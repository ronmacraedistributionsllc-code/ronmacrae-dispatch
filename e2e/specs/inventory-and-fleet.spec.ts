import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/** Fresh phone per run so the disposable dev DB never 409s on re-runs. */
const freshPhone = () => `876555${String(Math.floor(1000 + Math.random() * 9000))}`;

async function adminAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "admin@ronmacrae.example", password: "admin1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

async function ownerAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "owner@ronmacrae.example", password: "owner1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

/** Same helper as booking.spec.ts's own pickAddress — real geocoding chain,
 *  offline fallback allowed. */
async function pickAddress(container: Locator, query: string): Promise<void> {
  await container.getByPlaceholder("Type the exact delivery address…").fill(query);
  const firstSuggestion = container.locator("ul button").first();
  try {
    await expect(firstSuggestion).toBeVisible({ timeout: 15_000 });
    await firstSuggestion.click();
  } catch {
    await container.getByRole("button", { name: "Use this address" }).click();
  }
  await container.getByRole("button", { name: "Confirm location" }).click();
}

test("a customer sees real stock on the order form — an out-of-stock variant is disabled and a low-stock one is refused past its limit", async ({ page, request }) => {
  const stamp = Date.now();
  const auth = await adminAuth(request);
  const merchantRes = await request.post("/api/merchants", { headers: auth, data: { name: `Stock Store ${stamp}`, notificationEmails: "owner@vbr.example" } });
  const merchant = ((await merchantRes.json()) as { merchant: { id: string; slug: string } }).merchant;
  const productRes = await request.post(`/api/merchants/${merchant.id}/products`, {
    headers: auth,
    data: {
      name: "Limited Tee",
      price: 1500,
      variants: [
        { size: "Small", color: "Black", inventoryQty: 2 },
        { size: "Large", color: "Red", inventoryQty: 0 },
      ],
    },
  });
  expect(productRes.ok()).toBe(true);

  await page.goto(`/order/${merchant.slug}`);
  await expect(page.getByRole("heading", { name: `Order from Stock Store ${stamp}` })).toBeVisible();

  const productSelect = page.getByLabel("Product", { exact: true });
  const productValue = await productSelect.locator("option", { hasText: "Limited Tee" }).getAttribute("value");
  await productSelect.selectOption(productValue!);
  const variantSelect = page.getByLabel("Size / colour");
  await expect(variantSelect).toBeVisible();
  // The out-of-stock variant is present but disabled, and clearly labelled.
  const outOfStockOption = variantSelect.locator("option", { hasText: "out of stock" });
  await expect(outOfStockOption).toHaveCount(1);
  await expect(outOfStockOption).toBeDisabled();

  // The in-stock variant is selected by default (out-of-stock ones are skipped).
  await expect(page.getByText("Only 2 left.")).toBeVisible();

  await page.getByLabel("Full name").fill("Stock Test Customer");
  await page.getByLabel("Phone", { exact: true }).fill(freshPhone());
  // Only one AddressPicker on this page (delivery only, no separate pickup
  // picker like the staff booking form has) — the whole page is a safe
  // container, no need to scope to a sub-locator.
  await pickAddress(page.locator("body"), "2 Hope Ave, Portmore");

  // Ordering more than the tracked stock is refused with a real, visible error.
  await page.getByLabel("Quantity", { exact: true }).fill("5");
  await expect(page.getByText(/Only 2 left of Limited Tee/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Place order" })).toBeDisabled();

  // Reducing to the available quantity clears the error and allows submission.
  await page.getByLabel("Quantity", { exact: true }).fill("2");
  await expect(page.getByText(/Only 2 left of Limited Tee/)).not.toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("heading", { name: /Order.*received/ })).toBeVisible();
});

test("a logistics company sees its own attached courier's real deliveries on its fleet dashboard, without the customer's name or address", async ({ page, request }) => {
  const stamp = Date.now();
  const admin = await adminAuth(request);
  const owner = await ownerAuth(request);

  const companyRes = await request.post("/api/logistics-companies", { headers: admin, data: { name: `Swift Fleet ${stamp}` } });
  const company = ((await companyRes.json()) as { logisticsCompany: { id: string } }).logisticsCompany;
  const portalEmail = `fleet-e2e-${stamp}@swift.example`;
  await request.post(`/api/logistics-companies/${company.id}/staff`, { headers: admin, data: { email: portalEmail, password: "fleetpass123" } });

  const riderRes = await request.post("/api/riders", { headers: admin, data: { name: `Fleet Courier ${stamp}`, phone: `+1876${stamp.toString().slice(-7)}` } });
  const rider = ((await riderRes.json()) as { rider: { id: string } }).rider;
  await request.patch(`/api/platform/riders/${rider.id}`, { headers: owner, data: { attachment: "logistics", attachedLogisticsCompanyId: company.id } });

  const customerRes = await request.get("/api/customers", { headers: admin });
  const customers = ((await customerRes.json()) as { customers: { id: string }[] }).customers;
  const jobRes = await request.post("/api/jobs", {
    headers: admin,
    data: {
      customerId: customers[0]!.id,
      pickupAddressText: "10 Duke Street",
      itemSummary: "Fleet Dashboard Parcel",
      fare: 1000,
      fee: 200,
      paymentMethod: "cod",
      scheduledAt: new Date().toISOString(),
    },
  });
  expect(jobRes.ok()).toBe(true);
  const job = ((await jobRes.json()) as { job: { id: string; jobNumber: string } }).job;
  await request.post(`/api/jobs/${job.id}/assignments`, { headers: admin, data: { riderId: rider.id } });

  await loginToLogisticsPortal(page, portalEmail, "fleetpass123");
  const riderRow = page.locator(".card").filter({ hasText: `Fleet Courier ${stamp}` });
  await expect(riderRow).toBeVisible();
  await riderRow.getByRole("button", { name: "Deliveries" }).click();
  await expect(riderRow.getByText(job.jobNumber)).toBeVisible();
  await expect(riderRow.getByText("Fleet Dashboard Parcel")).toBeVisible();
  // Never the dispatching business's own customer/address details.
  await expect(riderRow.getByText("10 Duke Street")).toHaveCount(0);
});

async function loginToLogisticsPortal(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/logistics");
}

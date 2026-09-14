import { expect, test } from "@playwright/test";

/**
 * The shared sign-up page's business account types (spec Task C: "one
 * shared sign-up/login page for all users... Customer, Courier, Merchant
 * Business, and Bearer/Logistics Company") and Platform Admin's
 * application-review lifecycle (spec: "approve/reject/disable/reactivate/
 * inspect merchant applications"). Real browser coverage was flagged as
 * the one gap the existing vitest-only merchant-signup test left open —
 * this fills it, and covers logistics-company self-signup (previously
 * untested at any level) end to end.
 *
 * The verification-code step itself is deliberately never driven through
 * the browser here, same as my-packages.spec.ts's own rationale: the
 * code is delivered by email and this app never exposes it to any
 * browser/API surface (a real security requirement, not a test gap) — so
 * applications are created directly via the API instead of the join
 * forms, and Platform Admin's review endpoints don't require the email
 * to be verified first (only that the application still be pending).
 */

const OWNER = { email: "owner@ronmacrae.example", password: "owner1234" };

async function loginAs(page: import("@playwright/test").Page, identifier: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("the shared sign-in page offers all four account types", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Sign up as merchant" })).toHaveAttribute("href", "/join/merchant");
  await expect(page.getByRole("link", { name: "Sign up as courier" })).toHaveAttribute("href", "/join/rider");
  await expect(page.getByRole("link", { name: "Sign up as Bearer/Logistics Company" })).toHaveAttribute("href", "/join/logistics");
  await expect(page.getByRole("link", { name: "Sign up as customer" })).toHaveAttribute("href", "/book");
});

test("a pending merchant application shows in Platform Admin, can be approved, logs in through the shared page, then disabling it blocks that login again", async ({ page, request, browser }) => {
  const businessName = `E2E Merchant ${Date.now()}`;
  const email = `e2e-merchant-${Date.now()}@example.com`;
  const signup = await request.post("/api/merchant-signup", {
    data: { ownerName: "E2E Owner", businessName, email, phone: "8765551200", pickupAddressText: "Kingston", password: "securepass1" },
  });
  expect(signup.ok()).toBe(true);

  await loginAs(page, OWNER.email, OWNER.password);
  // Clicking through the nav (rather than a raw page.goto) naturally waits
  // for the async login to finish — the link only renders once the owner
  // session has actually loaded.
  await page.getByRole("link", { name: "Platform Admin" }).click();
  await page.getByRole("button", { name: "Merchants" }).click();
  await page.getByPlaceholder("Search…").fill(businessName);

  const row = page.locator(".card", { hasText: businessName });
  await expect(row.getByText("Pending review")).toBeVisible();
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByText("Pending review")).not.toBeVisible();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();

  // A separate browser context — the applicant, not the owner — logs in
  // through the one shared sign-in page and lands on their own portal.
  const applicantCtx = await browser.newContext();
  const applicantPage = await applicantCtx.newPage();
  await loginAs(applicantPage, email, "securepass1");
  await expect(applicantPage).toHaveURL(/\/merchant$/);
  await expect(applicantPage.getByRole("heading", { name: businessName })).toBeVisible();
  await applicantCtx.close();

  // Disable it — access is refused the same way a never-approved
  // application is (the shared login's own honest, generic message for
  // "no workspace this account can currently reach").
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(row.getByText("Active", { exact: true })).not.toBeVisible();

  const disabledCtx = await browser.newContext();
  const disabledPage = await disabledCtx.newPage();
  await loginAs(disabledPage, email, "securepass1");
  await expect(disabledPage.getByText("This account isn't connected to any business yet.")).toBeVisible();
  await disabledCtx.close();
});

test("Platform Admin can reject a pending logistics-company application with a reason, and that reason stays visible", async ({ page, request, browser }) => {
  const businessName = `E2E Fleet ${Date.now()}`;
  const email = `e2e-fleet-${Date.now()}@example.com`;
  const signup = await request.post("/api/logistics-signup", {
    data: { ownerName: "E2E Fleet Owner", businessName, email, phone: "8765551300", password: "securepass1" },
  });
  expect(signup.ok()).toBe(true);

  await loginAs(page, OWNER.email, OWNER.password);
  await page.getByRole("link", { name: "Platform Admin" }).click();
  await page.getByRole("button", { name: "Logistics" }).click();
  await page.getByPlaceholder("Search…").fill(businessName);

  const row = page.locator(".card", { hasText: businessName });
  await expect(row.getByText("Pending review")).toBeVisible();
  await row.getByRole("button", { name: "Reject" }).click();
  await row.getByPlaceholder(/Reason for rejecting/).fill("Fleet insurance documentation was incomplete");
  await row.getByRole("button", { name: "Confirm reject" }).click();

  await expect(row.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(row.getByText(/Fleet insurance documentation was incomplete/)).toBeVisible();

  const applicantCtx = await browser.newContext();
  const applicantPage = await applicantCtx.newPage();
  await loginAs(applicantPage, email, "securepass1");
  await expect(applicantPage.getByText("This account isn't connected to any business yet.")).toBeVisible();
  await applicantCtx.close();
});

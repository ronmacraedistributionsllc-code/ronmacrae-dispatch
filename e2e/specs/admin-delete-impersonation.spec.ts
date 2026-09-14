import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function login(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function adminAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "admin@ronmacrae.example", password: "admin1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

/** Creates a disposable merchant-staff account (spec parts 7/9's target —
 *  any account type works since delete/impersonate act on the shared User
 *  row, and this one is quick to create with a known password via the
 *  existing admin-only staff-grant endpoint). Shows up in Platform Admin's
 *  Staff tab because its role is "viewer", not "rider". */
async function makeDisposableStaffAccount(request: APIRequestContext): Promise<{ email: string; password: string; name: string }> {
  const auth = await adminAuth(request);
  const stamp = Date.now();
  const merchantRes = await request.post("/api/merchants", { headers: auth, data: { name: `Disposable Merchant ${stamp}`, notificationEmails: "owner@vbr.example" } });
  expect(merchantRes.ok()).toBe(true);
  const merchant = ((await merchantRes.json()) as { merchant: { id: string } }).merchant;
  const email = `e2e-target-${stamp}@example.com`;
  const password = "e2etarget123";
  const staffRes = await request.post(`/api/merchants/${merchant.id}/staff`, { headers: auth, data: { email, password, name: "Deletable Target" } });
  expect(staffRes.ok()).toBe(true);
  return { email, password, name: "Deletable Target" };
}

test("platform owner impersonates an account (spec: 'Login As'), sees the impersonation banner throughout, and exits cleanly with no password ever exposed or changed", async ({ page, request }) => {
  const target = await makeDisposableStaffAccount(request);

  await login(page, "owner@ronmacrae.example", "owner1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

  await page.getByRole("link", { name: "Platform Admin" }).click();
  await page.getByRole("button", { name: "Staff" }).click();
  await page.getByPlaceholder("Search…").fill(target.email);
  const row = page.locator(".card").filter({ hasText: target.name });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Login as" }).click();

  // The banner is the spec's own required wording, sticky on every screen.
  const banner = page.getByText("ADMIN IMPERSONATION ACTIVE");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Olivia Owner");
  await expect(banner).toContainText(target.name);

  await page.getByRole("button", { name: "Exit impersonation" }).click();
  await expect(page.getByText("ADMIN IMPERSONATION ACTIVE")).not.toBeVisible();
  // Exiting lands back on the owner's own console, still signed in as the owner.
  await expect(page.getByRole("heading", { name: "Platform Admin" })).toBeVisible();

  // The target's real password still works — impersonation never touched it.
  const relogin = await request.post("/api/merchant-portal/login", { data: { email: target.email, password: target.password } });
  expect(relogin.ok()).toBe(true);
});

test("platform owner deletes an account (spec: master admin global delete) with a typed-name confirmation, and it can never log in again", async ({ page, request }) => {
  const target = await makeDisposableStaffAccount(request);

  await login(page, "owner@ronmacrae.example", "owner1234");
  await page.getByRole("link", { name: "Platform Admin" }).click();
  await page.getByRole("button", { name: "Staff" }).click();
  await page.getByPlaceholder("Search…").fill(target.email);
  const row = page.locator(".card").filter({ hasText: target.name });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Delete", exact: true }).click();
  // A bare click on its own must not be enough — the Delete button inside
  // the confirmation stays disabled until the exact name is typed.
  const confirmDelete = row.getByRole("button", { name: "Delete", exact: true });
  await expect(confirmDelete).toBeDisabled();
  await row.getByPlaceholder(target.name).fill(target.name);
  await expect(confirmDelete).toBeEnabled();
  await confirmDelete.click();

  await expect(row.getByText("Deleted")).toBeVisible();

  const relogin = await request.post("/api/merchant-portal/login", { data: { email: target.email, password: target.password } });
  expect(relogin.status()).toBe(401);
});

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

/** Both app stores require these to be public and reachable without an account. */
test("privacy, terms, support and delete-account pages are public, reachable from the sign-in page, and marked DRAFT", async ({ page }) => {
  await page.goto("/login");
  for (const [name, path, heading] of [
    ["Privacy", "/privacy", "Privacy policy"],
    ["Terms", "/terms", "Terms of use"],
    ["Support", "/support", "Support"],
    ["Delete account", "/delete-account", "Delete your account"],
  ] as const) {
    await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute("href", path);
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    // Unreviewed legal text must never look final.
    await expect(page.getByTestId("draft-banner")).toContainText("DRAFT");
    await page.goto("/login");
  }
});

test("the privacy policy says what deletion keeps, and the deletion page says how to do it", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByText(/does not\s+erase past orders/i)).toBeVisible();
  await expect(page.getByText(/precise location/i).first()).toBeVisible();
  await page.goto("/delete-account");
  await expect(page.getByText("My account").first()).toBeVisible();
});

test("a courier deletes their own account from inside the app and can never sign in again", async ({ page, request }) => {
  const auth = await dispatcherAuth(request);
  const phone = `+18768${Date.now().toString().slice(-7)}`;
  const password = "deleteMe-12345";
  const created = await request.post("/api/riders", { headers: auth, data: { name: "Delete Flow Courier", phone, password } });
  expect(created.ok()).toBe(true);

  await login(page, phone, password);
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();

  await page.getByRole("link", { name: "My account" }).click();
  await expect(page.getByRole("heading", { name: "My account" })).toBeVisible();
  await page.getByRole("button", { name: /Delete my account/ }).click();

  const confirm = page.getByRole("button", { name: "Permanently delete my account" });
  // Nothing happens until BOTH the typed confirmation and password are given.
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await expect(confirm).toBeDisabled();

  // A wrong password is refused and the account survives.
  await page.getByLabel("Your password").fill("not-my-password");
  await confirm.click();
  await expect(page.getByRole("alert")).toContainText(/isn't correct/i);

  await page.getByLabel("Your password").fill(password);
  await confirm.click();
  await expect(page).toHaveURL(/\/login/);

  // Signing in again is refused with the specific reason.
  await login(page, phone, password);
  await expect(page.getByText("Account deleted")).toBeVisible();
});

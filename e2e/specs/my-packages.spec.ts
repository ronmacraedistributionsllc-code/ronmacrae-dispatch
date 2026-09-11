import { test, expect } from "@playwright/test";

const freshPhone = () => `876555${String(Math.floor(1000 + Math.random() * 9000))}`;

/**
 * Cross-business customer package dashboard (Stage 22 / spec 4), public page
 * at /my-packages. Covers the real-browser wiring up through requesting a
 * code: phone submission, validation, the resend cooldown, and the "wrong
 * number" back-step.
 *
 * Deliberately stops there. The actual 6-digit code is delivered by SMS
 * (the memory provider in dev/e2e just logs it) and is never exposed to any
 * staff view or API response by design — see customer-dashboard.test.ts's
 * own "never exposes the customer-dashboard code..." test, which asserts
 * exactly that. There is no legitimate way for this black-box browser test
 * (or a real anonymous visitor without their phone) to read it, so the
 * full request -> verify -> dashboard round trip is covered instead at the
 * API-integration level (apps/api/test/customer-dashboard.test.ts), which
 * has real Prisma access to read the code the same way a delivered SMS
 * would have carried it.
 */
test("customer requests a dashboard access code, sees the code step, and can go back to try a different number", async ({ page }) => {
  await page.goto("/my-packages");
  await expect(page.getByText("My packages", { exact: true })).toBeVisible();

  await page.getByLabel("Your phone number").fill(freshPhone());
  await page.getByRole("button", { name: "Send code" }).click();

  await expect(page.getByLabel("6-digit code")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resend code" })).toBeDisabled();

  await page.getByRole("button", { name: "Wrong number?" }).click();
  await expect(page.getByLabel("Your phone number")).toBeVisible();
});

test("an invalid phone number shows an inline error instead of advancing", async ({ page }) => {
  await page.goto("/my-packages");
  // 4+ chars so it clears the request body's own min-length check and
  // actually reaches phone normalization — a too-short string would fail
  // that earlier, generic validation instead of the one this test targets.
  await page.getByLabel("Your phone number").fill("abcd");
  await page.getByRole("button", { name: "Send code" }).click();

  await expect(page.getByText("Enter a valid phone number.")).toBeVisible();
  await expect(page.getByLabel("Your phone number")).toBeVisible();
});

/**
 * Optional email+password account (Stage 25 / spec 7) — same constraint as
 * above: the email verification/reset code is never exposed to a browser
 * test, so this covers the real-browser navigation and validation only.
 * The full claim -> verify -> login and reset round trips are covered at
 * the API-integration level (apps/api/test/customer-account.test.ts),
 * which can read the code off the memory email provider's own log.
 */
test("a customer can navigate to email sign-in, sees a generic error on the wrong credentials, and can reach password reset", async ({ page }) => {
  await page.goto("/my-packages");
  await page.getByRole("button", { name: "Have an account? Sign in with email" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();

  await page.getByLabel("Email").fill("nobody-e2e@example.com");
  await page.getByLabel("Password").fill("wrongpassword1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();

  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.getByText("We'll email a reset code if that address has an account.")).toBeVisible();
  await page.getByLabel("Email").fill("nobody-e2e@example.com");
  await page.getByRole("button", { name: "Send reset code" }).click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  await expect(page.getByLabel("New password")).toBeVisible();

  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page.getByLabel("Password")).toBeVisible();
  await page.getByRole("button", { name: "Use my phone number instead" }).click();
  await expect(page.getByLabel("Your phone number")).toBeVisible();
});

test("the per-job tracking page links through to the cross-business dashboard", async ({ page, request }) => {
  const res = await request.post("/api/delivery-requests", {
    data: {
      name: "Dash Link Customer",
      phone: freshPhone(),
      addressText: "1 Dashboard Lane, Kingston",
      itemSummary: "Test package",
      paymentMethod: "cod",
    },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { tracking: { token: string } | null };

  await page.goto(`/track/${body.tracking!.token}`);
  await page.getByRole("link", { name: "See all my packages" }).click();
  await expect(page.getByText("My packages", { exact: true })).toBeVisible();
});

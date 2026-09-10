import { expect, test } from "@playwright/test";

test("api health endpoint responds", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { ok: boolean; service: string };
  expect(body.ok).toBe(true);
  expect(body.service).toContain("ronmacrae");
});

test("unauthenticated requests to the dashboard are redirected to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("Dispatch")).toBeVisible();
});

test("admin can log in and see the dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill("admin@ronmacrae.example");
  await page.getByLabel("Password").fill("admin1234");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Zones & Fares" })).toBeVisible();
});

test("dispatcher can quote a fare between zones", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill("dispatcher@ronmacrae.example");
  await page.getByLabel("Password").fill("dispatch1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

  await page.getByRole("link", { name: "Zones & Fares" }).click();
  await page.getByLabel("From").selectOption({ label: "Kingston Central" });
  await page.getByLabel("To").selectOption({ label: "Portmore" });
  await page.getByRole("button", { name: "Quote fee" }).click();

  await expect(page.getByText(/routing/)).toBeVisible();
});

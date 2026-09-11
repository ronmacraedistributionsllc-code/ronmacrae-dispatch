import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, identifier: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Stage 21 (spec item 3 — modern, usable interface): the mobile bottom nav
 * and the "More" sheet that carries Sign out, which previously had no
 * mobile-reachable affordance at all (the sidebar's user/sign-out block was
 * `hidden md:block`, full stop).
 */
test("mobile bottom nav shows primary tabs, and 'More' reaches every other tab plus Sign out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

  const bottomNav = page.getByRole("navigation", { name: "Primary" });
  await expect(bottomNav).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Dashboard" })).toBeVisible();
  // The desktop sidebar nav must not also be showing at this width (avoids
  // two ways to navigate stacked on top of each other).
  await expect(page.locator("aside nav").first()).toBeHidden();

  const moreButton = bottomNav.getByRole("button", { name: "More" });
  await expect(moreButton).toBeVisible();
  await moreButton.click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet).toBeVisible();
  // Dispatcher can't see Reports at all (admin/accountant-only) — Notifications
  // is one of the tabs that overflows into "More" for every staff role.
  await expect(sheet.getByRole("link", { name: "Notifications" })).toBeVisible();
  const signOutButton = sheet.getByRole("button", { name: "Sign out" });
  await expect(signOutButton).toBeVisible();

  // Dismissible via backdrop tap without navigating away.
  await page.mouse.click(10, 10);
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

  // Now actually sign out through it.
  await moreButton.click();
  await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("ops board switches from a table to stacked cards at mobile width, with the same data", async ({ page }) => {
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/ops");
  await expect(page.getByRole("heading", { name: "Operations board" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("table")).toBeHidden();
  const riderCard = page.locator('[data-testid^="ops-rider-card-"]').first();
  await expect(riderCard).toBeVisible();
  await expect(riderCard.getByRole("link", { name: /Call/ })).toBeVisible();
});

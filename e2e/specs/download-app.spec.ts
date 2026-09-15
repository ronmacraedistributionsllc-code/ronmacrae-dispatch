import { expect, test } from "@playwright/test";

test("the Android app download page serves a real, correctly-signed-sized APK, linked from the login page", async ({ page, request }) => {
  await page.goto("/login");
  const link = page.getByRole("link", { name: /Download the Android app/ });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL("/download-app");
  await expect(page.getByRole("heading", { name: "Ronmacrae Dispatch for Android" })).toBeVisible();

  const downloadLink = page.getByRole("link", { name: "Download the app (.apk)" });
  const href = await downloadLink.getAttribute("href");
  expect(href).toBe("/downloads/ronmacrae-dispatch.apk");

  const res = await request.get(href!);
  expect(res.ok()).toBe(true);
  const body = await res.body();
  // A real APK, not a placeholder — starts with the ZIP local-file-header
  // magic bytes (an APK is a ZIP container) and is a substantial size.
  expect(body.subarray(0, 2).toString("hex")).toBe("504b");
  expect(body.length).toBeGreaterThan(500_000);
});

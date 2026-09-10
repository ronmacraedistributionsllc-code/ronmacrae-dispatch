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

// A real, fixed test coordinate — Half Way Tree, Kingston.
const TEST_COORDS = { latitude: 18.0092, longitude: -76.7936 };

test("rider foreground GPS sharing reports a real position, and pauses honestly when the tab is hidden", async ({ page, request, context }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18770${Date.now().toString().slice(-7)}`;
  const riderPassword = "gpsRider1234";
  await request.post("/api/riders", { headers: auth, data: { name: "GPS Test Rider", phone: uniquePhone, password: riderPassword } });

  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(TEST_COORDS);

  await login(page, uniquePhone, riderPassword);
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();

  const [reportResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().includes("/api/rider-locations/") && res.url().endsWith("/report") && res.request().method() === "POST"),
    page.getByRole("button", { name: "Share my location" }).click(),
  ]);
  expect(reportResponse.ok()).toBe(true);
  const reportBody = reportResponse.request().postDataJSON() as { point: { lat: number; lng: number }; trackingState: string };
  expect(reportBody.trackingState).toBe("active");
  expect(reportBody.point.lat).toBeCloseTo(TEST_COORDS.latitude, 3);
  expect(reportBody.point.lng).toBeCloseTo(TEST_COORDS.longitude, 3);

  await expect(page.getByText(/Sharing · last sent/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop sharing location" })).toBeVisible();

  // Foreground-only claim: hiding the tab must visibly pause sharing, not silently
  // keep "sharing" displayed while nothing is actually being sent.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("button", { name: "Resume sharing" })).toBeVisible();
  await expect(page.getByText(/Paused — the app was in the background/)).toBeVisible();
});

test("a dispatcher's live map shows a rider's real GPS position", async ({ page, request, context }) => {
  const auth = await dispatcherAuth(request);
  const uniquePhone = `+18771${Date.now().toString().slice(-7)}`;
  const riderPassword = "gpsMapRider1234";
  const riderRes = await request.post("/api/riders", { headers: auth, data: { name: "Map Test Rider", phone: uniquePhone, password: riderPassword } });
  expect(riderRes.ok()).toBe(true);

  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(TEST_COORDS);

  // Report a position directly via the API (this spec's focus is the dispatcher map
  // consuming it, not re-proving the rider UI — that's the spec above).
  const riderLogin = await request.post("/api/auth/login", { data: { identifier: uniquePhone, password: riderPassword } });
  const riderAuth = { authorization: `Bearer ${((await riderLogin.json()) as { accessToken: string }).accessToken}` };
  const meRes = await request.get("/api/auth/me", { headers: riderAuth });
  const riderId = ((await meRes.json()) as { rider: { id: string } }).rider.id;
  const reportRes = await request.post(`/api/rider-locations/${riderId}/report`, {
    headers: riderAuth,
    data: { point: { lat: TEST_COORDS.latitude, lng: TEST_COORDS.longitude }, trackingState: "active" },
  });
  expect(reportRes.ok()).toBe(true);

  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/map");
  await expect(page.getByRole("heading", { name: "Live map" })).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  // Scoped by this run's own rider id — the accumulated dev db has other riders
  // from earlier runs of this same spec, all literally named "Map Test Rider" too,
  // so neither text nor the list alone is unambiguous.
  const row = page.getByTestId(`rider-row-${riderId}`);
  await expect(row).toBeVisible();
  await expect(row.getByText("Map Test Rider")).toBeVisible();
  await expect(row.getByText(/active · (just now|\d+s ago)/)).toBeVisible();
});

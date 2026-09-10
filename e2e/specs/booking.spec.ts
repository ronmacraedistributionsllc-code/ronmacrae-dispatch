import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/** Fresh phone per run so the disposable dev DB never 409s on re-runs. */
const freshPhone = () => `876555${String(Math.floor(1000 + Math.random() * 9000))}`;

async function loginAsDispatcher(page: Page, request: APIRequestContext): Promise<Record<string, string>> {
  await page.goto("/login");
  await page.getByLabel("Email or phone").fill("dispatcher@ronmacrae.example");
  await page.getByLabel("Password").fill("dispatch1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

  const res = await request.post("/api/auth/login", {
    data: { identifier: "dispatcher@ronmacrae.example", password: "dispatch1234" },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

/**
 * Drives one AddressPicker instance (see components/address-picker.tsx): type a
 * query, wait for real suggestions (this hits the actual geocoding chain — real
 * network, with a deterministic offline fallback — so it's given a generous
 * timeout), pick the first one, and confirm the pin.
 */
async function pickAddress(container: Locator, query: string): Promise<void> {
  await container.getByPlaceholder("Start typing an address…").fill(query);
  const firstSuggestion = container.locator("ul button").first();
  await expect(firstSuggestion).toBeVisible({ timeout: 15_000 });
  await firstSuggestion.click();
  await container.getByRole("button", { name: "Confirm location" }).click();
}

/** Read the job number + tracking token out of the staff booking success card. */
async function readBookingResult(page: Page): Promise<{ jobNumber: string; token: string }> {
  const heading = await page.getByText(/Booked — RM-\d{6}/).first().textContent();
  const jobNumber = heading?.match(/RM-\d{6}/)?.[0] ?? "";
  expect(jobNumber).toBeTruthy();
  const href = await page.getByRole("link", { name: /\/track\// }).first().getAttribute("href");
  const token = href?.split("/track/")[1] ?? "";
  expect(token).toBeTruthy();
  return { jobNumber: jobNumber!, token: token! };
}

test("staff books a delivery from the New Order form and gets a tracking link", async ({ page, request }) => {
  await loginAsDispatcher(page, request);

  await page.goto("/jobs/new");
  await expect(page.getByRole("heading", { name: "Book a delivery" })).toBeVisible();

  // Step 1: address-first — the rest of the form is hidden until the destination
  // is confirmed via search -> suggestion -> map pin -> "Confirm location".
  await expect(page.getByLabel("First name")).not.toBeVisible();
  const step1 = page.locator("section.card").filter({ has: page.getByRole("heading", { name: /Step 1/ }) });
  await pickAddress(step1, "5 Rose Ave, Old Rose Garden, Kingston, Jamaica");

  await expect(page.getByLabel("First name")).toBeVisible();
  await page.getByLabel("First name").fill("Tanya");
  await page.getByLabel("Last name", { exact: false }).fill("Booker");
  await page.getByLabel("Phone", { exact: true }).fill(freshPhone());

  // Pickup defaults to the store address and loads asynchronously (its own
  // geocode call) — wait for it to resolve to the collapsed "confirmed" state
  // rather than assuming it's ready immediately.
  await expect(page.getByText("Loading default pickup location…")).not.toBeVisible({ timeout: 15_000 });
  // The real geocoder's formatted address for the default pickup won't necessarily
  // echo back the exact house-number string we searched for — just confirm it
  // resolved to somewhere on the right street, not the literal input text.
  await expect(page.getByText("Half Way Tree Road", { exact: false })).toBeVisible();

  await page.getByLabel("Landmark", { exact: false }).fill("behind the red gate");
  await page.getByLabel("Product", { exact: true }).fill("Black bomber jacket");
  await page.getByLabel("Colour", { exact: false }).fill("Black");
  await page.getByLabel("Size", { exact: false }).fill("M");
  await page.getByLabel("Quantity", { exact: true }).fill("2");

  await page.getByLabel("Urgent delivery", { exact: false }).check();
  await page.getByLabel("Courier type").selectOption({ label: "Local delivery (our riders)" });
  await page.getByLabel("Delivery instructions", { exact: false }).fill("Gate code 4421, ring twice");

  await page.getByLabel("Order value", { exact: false }).fill("4500");
  await page.getByLabel("Delivery fee", { exact: false }).fill("350");
  await page.getByLabel("Payment", { exact: true }).selectOption({ label: "Cash on delivery" });

  await page.getByRole("button", { name: "Book delivery" }).click();

  const result = await readBookingResult(page);
  const successCard = page.locator("section").filter({ hasText: /Booked — / });
  await expect(successCard.getByText("Cash on delivery")).toBeVisible();
  await expect(successCard.getByText("URGENT")).toBeVisible();

  // the job lands in the dispatch queue, flagged urgent
  await page.goto("/jobs");
  const row = page.getByRole("row", { name: result.jobNumber });
  await expect(row).toBeVisible();
  await expect(row.getByText("Tanya Booker")).toBeVisible();
  await expect(row.getByText("Urgent", { exact: true })).toBeVisible();

  // the customer tracking link opens the public tracking page
  await page.goto(`/track/${result.token}`);
  await expect(page.getByRole("heading", { name: /Delivery confirmed/ })).toBeVisible();
  await expect(page.getByText(result.jobNumber)).toBeVisible();
});

test("customer books a delivery from the public form and gets a tracking link", async ({ page }) => {
  await page.goto("/book");
  await expect(page.getByRole("heading", { name: "Book a delivery" })).toBeVisible();

  await page.getByLabel("Your name").fill("Kadee Public");
  await page.getByLabel("Phone").fill(freshPhone());
  await page.getByLabel("Deliver to").fill("2 Hope Ave, Portmore");
  await page.getByLabel("Landmark (optional)").fill("blue gate");
  await page.getByLabel("Product").fill("White canvas tote");
  await page.getByLabel("Quantity", { exact: true }).fill("1");
  await page.getByLabel("Order value").fill("1200");
  await page.getByLabel("Payment", { exact: true }).selectOption({ label: "Paid online" });

  await page.getByRole("button", { name: "Book my delivery" }).click();

  await expect(page.getByText(/Order RM-\d{6} is booked/)).toBeVisible();
  const href = await page.getByRole("link", { name: "Open your tracking page" }).getAttribute("href");
  expect(href).toContain("/track/");
  await page.goto(href!);
  await expect(page.getByRole("heading", { name: /Delivery confirmed/ })).toBeVisible();
});

test("public delivery-request endpoint returns a job number and tracking link", async ({ request }) => {
  const res = await request.post("/api/delivery-requests", {
    data: {
      name: "Rina Api",
      phone: freshPhone(),
      addressText: "9 Hope Ave, Portmore",
      landmark: "green roof",
      itemSummary: "Grey hoodie",
      itemColor: "Grey",
      itemSize: "L",
      quantity: 3,
      fare: 3000,
      fee: 250,
      paymentMethod: "online",
    },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    jobNumber: string | null;
    customerName: string;
    tracking: { token: string; url: string } | null;
  };
  expect(body.jobNumber).toMatch(/^RM-\d{6}$/);
  expect(body.customerName).toBe("Rina Api");
  expect(body.tracking?.token).toBeTruthy();

  const tracked = await request.get(`/api/tracking/${body.tracking!.token}`);
  expect(tracked.ok()).toBe(true);
  const pub = (await tracked.json()) as { job: { jobNumber: string | null; customerStatus: string } };
  expect(pub.job.jobNumber).toBe(body.jobNumber);
  expect(pub.job.customerStatus).toBe("confirmed");
});

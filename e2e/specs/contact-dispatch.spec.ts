import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function dispatcherAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "dispatcher@ronmacrae.example", password: "dispatch1234" } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

async function adminAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { identifier: "admin@ronmacrae.example", password: "admin1234" } });
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

test("a rider sees a 'Contact dispatch' Call/Message action on an active job, using only the configured dispatch number", async ({ page, request }) => {
  const admin = await adminAuth(request);
  const dispatchPhone = "+18765554321";
  const settingsRes = await request.put("/api/settings/business", { headers: admin, data: { businessName: "E2E Courier", dispatchPhone, dispatchWhatsApp: "" } });
  expect(settingsRes.ok()).toBe(true);

  const auth = await dispatcherAuth(request);
  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;
  const riders = ((await (await request.get("/api/riders", { headers: auth })).json()) as { riders: { id: string; name: string }[] }).riders;
  const kei = riders.find((r) => r.name === "Kei Bearer")!;

  const jobLabel = `Contact e2e parcel ${Date.now()}`;
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: jobLabel } });
  const createdJob = (await created.json()) as { job: { id: string; jobNumber: string | null } };
  const jobNumber = createdJob.job.jobNumber ?? createdJob.job.id.slice(0, 8);
  await request.post(`/api/jobs/${createdJob.job.id}/assignments`, { headers: auth, data: { riderId: kei.id } });

  await login(page, "+8765550001", "rider1234");
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: jobNumber }) });
  await expect(card.getByText(`Contact dispatch about ${jobNumber}`)).toBeVisible();
  const callLink = card.getByRole("link", { name: "Call" });
  await expect(callLink).toHaveAttribute("href", `tel:${dispatchPhone}`);
  const messageLink = card.getByRole("link", { name: "Message" });
  const messageHref = await messageLink.getAttribute("href");
  expect(messageHref).toContain(`sms:${dispatchPhone}?body=`);
  expect(decodeURIComponent(messageHref ?? "")).toContain(jobNumber);
  // No WhatsApp button was configured — none should appear.
  await expect(card.getByRole("link", { name: "WhatsApp" })).not.toBeVisible();
});

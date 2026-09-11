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

test("customer, rider, and dispatcher exchange messages across the three real conversations, and a customer's address-change request is reviewed before it takes effect", async ({ page, request, browser }) => {
  const auth = await dispatcherAuth(request);
  const customers = ((await (await request.get("/api/customers", { headers: auth })).json()) as { customers: { id: string; phone: string }[] }).customers;
  const customer = customers.find((c) => c.phone === "+8765551234")!;
  const riders = ((await (await request.get("/api/riders", { headers: auth })).json()) as { riders: { id: string; name: string }[] }).riders;
  const kei = riders.find((r) => r.name === "Kei Bearer")!;

  const jobLabel = `Chat e2e parcel ${Date.now()}`;
  const created = await request.post("/api/jobs", { headers: auth, data: { customerId: customer.id, itemSummary: jobLabel, addressText: "Original Chat Address" } });
  const createdJob = (await created.json()) as { job: { id: string; jobNumber: string | null } };
  const jobId = createdJob.job.id;
  const jobNumber = createdJob.job.jobNumber ?? jobId.slice(0, 8);
  await request.post(`/api/jobs/${jobId}/assignments`, { headers: auth, data: { riderId: kei.id } });
  const linkRes = await request.post(`/api/jobs/${jobId}/tracking-link`, { headers: auth });
  const trackToken = ((await linkRes.json()) as { link: { token: string } }).link.token;

  // Customer's page defaults to the Customer↔Dispatch tab.
  const customerCtx = await browser.newContext();
  const customerPage = await customerCtx.newPage();
  await customerPage.goto(`/track/${trackToken}`);
  await expect(customerPage.getByRole("heading", { name: jobNumber })).toBeVisible();
  await expect(customerPage.getByRole("tab", { name: /Customer ↔ Dispatch/ })).toHaveAttribute("aria-selected", "true");
  await customerPage.getByPlaceholder("Type a message…").fill("Please hurry, I have a flight to catch");
  await customerPage.getByRole("button", { name: "Send" }).click();
  await expect(customerPage.getByText("Please hurry, I have a flight to catch")).toBeVisible();

  await customerPage.getByRole("button", { name: "Request address change" }).click();
  await customerPage.getByPlaceholder("Type the exact new address").fill("Chat E2E New Address");
  await customerPage.getByRole("button", { name: "Send request" }).click();
  await expect(customerPage.getByText(/Waiting for dispatch to confirm/)).toBeVisible();

  // Customer switches to the Customer↔Rider tab and messages the rider directly —
  // this must never show up in the dispatcher's Customer↔Dispatch view.
  await customerPage.getByRole("tab", { name: /Customer ↔ Rider/ }).click();
  await customerPage.getByPlaceholder("Type a message…").fill("Please call when you arrive");
  await customerPage.getByRole("button", { name: "Send" }).click();
  await expect(customerPage.getByText("Please call when you arrive")).toBeVisible();

  // Dispatcher sees the customer's Customer↔Dispatch message and the pending
  // address-change request — but never the Customer↔Rider message.
  await login(page, "dispatcher@ronmacrae.example", "dispatch1234");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.goto("/jobs");
  const row = page.getByRole("row", { name: jobNumber });
  await row.getByRole("button", { name: "Messages" }).click();
  const chatPanel = page.getByTestId(`chat-panel-${jobId}`);
  await expect(chatPanel.getByRole("tab", { name: /Customer ↔ Dispatch/ })).toHaveAttribute("aria-selected", "true");
  await expect(chatPanel.getByText("Please hurry, I have a flight to catch")).toBeVisible();
  await expect(chatPanel.getByText("Chat E2E New Address").first()).toBeVisible();
  await expect(chatPanel.getByText("Please call when you arrive")).not.toBeVisible();

  // Staff can monitor Customer↔Rider (read-only) but it's clearly marked as such.
  await chatPanel.getByRole("tab", { name: /Customer ↔ Rider/ }).click();
  await expect(chatPanel.getByText("Please call when you arrive")).toBeVisible();
  await expect(chatPanel.getByText("Monitor-only")).toBeVisible();
  await chatPanel.getByRole("tab", { name: /Customer ↔ Dispatch/ }).click();

  // Confirming the address change actually updates the job — not silently, only via this explicit action.
  await chatPanel.getByRole("button", { name: "Confirm change" }).click();
  await expect(chatPanel.getByText(/Dispatch confirmed the new delivery address/)).toBeVisible();
  const jobAfter = await request.get(`/api/jobs/${jobId}`, { headers: auth });
  expect(((await jobAfter.json()) as { job: { addressText: string | null } }).job.addressText).toBe("Chat E2E New Address");

  // Dispatcher replies on the Customer↔Dispatch conversation.
  const chatInput = chatPanel.locator("input.input");
  await chatInput.fill("On it — sending our fastest rider!");
  await chatPanel.getByRole("button", { name: "Send" }).click();
  await expect(chatPanel.getByText("On it — sending our fastest rider!")).toBeVisible();

  // Rider, once assigned, sees Customer↔Rider (default tab) and Rider↔Dispatch —
  // never Customer↔Dispatch at all.
  // (Sign out first — the dispatcher session is still live, and /login redirects
  // an already-authenticated user instead of showing the form.)
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, "+8765550001", "rider1234");
  await expect(page.getByRole("heading", { name: "My deliveries" })).toBeVisible();
  const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: jobNumber }) });
  await card.getByRole("button", { name: "Message customer" }).click();
  await expect(card.getByRole("tab", { name: /Customer ↔ Rider/ })).toHaveAttribute("aria-selected", "true");
  await expect(card.getByText("Please call when you arrive")).toBeVisible();
  await expect(card.getByRole("tab", { name: /Customer ↔ Dispatch/ })).toHaveCount(0);
  await card.getByRole("button", { name: "Heading to you" }).click();
  await expect(card.locator("p.whitespace-pre-wrap", { hasText: "Heading to you" })).toBeVisible();

  // The address-change confirmation reached the rider too, on Rider↔Dispatch —
  // riders need it for navigation, even though they weren't part of the review.
  await card.getByRole("tab", { name: /Rider ↔ Dispatch/ }).click();
  await expect(card.getByText(/Dispatch confirmed the new delivery address/)).toBeVisible();

  // Customer's Customer↔Rider tab (still open, polling) eventually shows the
  // rider's "Heading to you" reply.
  await customerPage.getByRole("tab", { name: /Customer ↔ Rider/ }).click();
  await expect(customerPage.getByText("Heading to you")).toBeVisible({ timeout: 20_000 });
  // ...but the dispatcher's earlier Customer↔Dispatch reply never leaks in here.
  await expect(customerPage.getByText("On it — sending our fastest rider!")).not.toBeVisible();

  await customerCtx.close();
});

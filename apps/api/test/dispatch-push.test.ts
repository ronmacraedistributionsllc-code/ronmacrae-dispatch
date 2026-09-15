/**
 * "When an order comes in, dispatch should get a notification the same
 * way a courier already gets pushed for a new offer" — a real gap: a
 * new job previously had no realtime (WebSocket) or push signal to
 * dispatch at all, only the existing opt-in, per-business
 * dispatchNotificationEmail (see dispatch-notify.ts), which most
 * businesses never configure. Covers both places a job actually gets
 * created: the public/merchant order form (order.ts) and staff's own
 * "New order" booking (jobs/create.ts) — two genuinely separate code
 * paths, not one shared function underneath.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeStaff(h: TestHarness, role: "admin" | "dispatcher" | "accountant" | "viewer", name = `Staff ${uniq()}`) {
  const user = await h.prisma.user.create({ data: { name, passwordHash: "unused-in-tests", role } });
  await h.prisma.staffMembership.create({ data: { userId: user.id, businessId: h.business.id, role, active: true } });
  const token = await h.tokenFor({ id: user.id, name: user.name, role, businessId: h.business.id });
  return { user, token };
}

async function makeMerchant(h: TestHarness, auth: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/merchants",
    headers: { authorization: `Bearer ${auth}` },
    payload: { name: `Push Notify Merchant ${uniq()}` },
  });
  return (res.json() as { merchant: { id: string; slug: string } }).merchant;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-dispatch-push");
});

afterAll(async () => {
  await harness.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatch is notified (realtime + push) when a new order comes in", () => {
  it("a public order pushes every admin/dispatcher at that business, excludes accountant/viewer, with a generic body", async () => {
    const admin = await makeStaff(harness, "admin", "Order Push Admin");
    const dispatcher = await makeStaff(harness, "dispatcher", "Order Push Dispatcher");
    const accountant = await makeStaff(harness, "accountant", "Order Push Accountant");
    const merchant = await makeMerchant(harness, admin.token);
    const sendToUser = vi.spyOn(harness.ctx.push, "sendToUser").mockResolvedValue(undefined);

    const res = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: {
        name: "Push Test Customer",
        phone: `+18765${uniq().slice(-7)}`,
        addressText: "Somewhere",
        items: [{ name: "Test Item", quantity: 1, unitPrice: 1000 }],
      },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10)); // push is fire-and-forget

    const pushedTo = sendToUser.mock.calls.map((c) => c[0]);
    expect(pushedTo).toContain(admin.user.id);
    expect(pushedTo).toContain(dispatcher.user.id);
    expect(pushedTo).not.toContain(accountant.user.id);

    const payload = sendToUser.mock.calls[0]![1] as { title: string; body: string };
    expect(payload.title).toBe("New order");
    // Generic — never the customer's own name/phone/address in the push body.
    expect(payload.body).not.toContain("Push Test Customer");
    expect(payload.body).not.toContain("Somewhere");
  });

  it("a public order broadcasts job.created to this business's own dispatch room, live", async () => {
    const admin = await makeStaff(harness, "admin");
    const merchant = await makeMerchant(harness, admin.token);
    const broadcast = vi.spyOn(harness.ctx.hub, "broadcast");

    const res = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: { name: "Realtime Test", phone: `+18765${uniq().slice(-7)}`, addressText: "Somewhere", items: [{ name: "Item", quantity: 1, unitPrice: 500 }] },
    });
    expect(res.statusCode).toBe(200);

    const jobCreatedCall = broadcast.mock.calls.find((c) => (c[1] as { type?: string }).type === "job.created");
    expect(jobCreatedCall).toBeTruthy();
    expect(jobCreatedCall![0]).toBe(`dispatch:${harness.business.id}`);
  });

  it("a staff-created booking pushes OTHER admin/dispatcher staff, but never the dispatcher who just created it", async () => {
    const creator = await makeStaff(harness, "dispatcher", "Booking Creator");
    const otherDispatcher = await makeStaff(harness, "dispatcher", "Other Dispatcher");
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Booking Customer", phone: `+18765${uniq().slice(-7)}` } });
    const sendToUser = vi.spyOn(harness.ctx.push, "sendToUser").mockResolvedValue(undefined);

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { authorization: `Bearer ${creator.token}` },
      payload: { customerId: customer.id, itemSummary: "Staff Booked Item", fare: 1000, paymentMethod: "cod" },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10));

    const pushedTo = sendToUser.mock.calls.map((c) => c[0]);
    expect(pushedTo).toContain(otherDispatcher.user.id);
    expect(pushedTo).not.toContain(creator.user.id);
  });
});

/**
 * Delivery messaging (Stage 18 / spec 5G): real Fastify app + real sqlite db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeCustomer(h: TestHarness) {
  return h.prisma.customer.create({ data: { businessId: h.business.id,  name: "Msg Test Customer", phone: `+1876572${uniq()}` } });
}
async function makeRider(h: TestHarness) {
  const rider = await h.prisma.rider.create({ data: { name: "Msg Test Rider", phone: `+1876573${uniq()}`, active: true, status: "available" } });
  const user = await h.prisma.user.create({ data: { name: rider.name, passwordHash: "unused-in-tests", role: "rider" } });
  const token = await h.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, token };
}
async function staffToken(h: TestHarness, role: "admin" | "dispatcher" | "accountant" | "viewer") {
  const user = await h.prisma.user.create({ data: { name: `Msg ${role}`, passwordHash: "unused-in-tests", role } });
  return h.tokenFor({ id: user.id, name: user.name, role });
}
async function makeJobWithLink(h: TestHarness, customerId: string, overrides: Record<string, unknown> = {}) {
  const job = await h.prisma.job.create({ data: { businessId: h.business.id,  customerId, status: "assigned", ...overrides } });
  const link = await h.prisma.trackingLink.create({ data: { jobId: job.id, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000) } });
  return { job, link };
}

beforeAll(async () => {
  harness = await buildTestHarness("test-delivery-messages");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("basic conversation: customer, rider, dispatcher", () => {
  it("a customer and a dispatcher can exchange messages, each seeing the other's text", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id);
    const dispatcherTok = await staffToken(harness, "dispatcher");

    const customerSend = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages`, payload: { body: "Where is my order?" } });
    expect(customerSend.statusCode).toBe(200);

    const staffRead = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect(staffRead.statusCode).toBe(200);
    const staffBody = staffRead.json() as { messages: { senderRole: string; body: string; senderName: string }[] };
    expect(staffBody.messages).toHaveLength(1);
    expect(staffBody.messages[0]!.body).toBe("Where is my order?");
    expect(staffBody.messages[0]!.senderName).toBe("Customer");

    const staffSend = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/messages`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: { body: "On the way!" } });
    expect(staffSend.statusCode).toBe(200);

    const customerRead = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages` });
    const customerBody = customerRead.json() as { messages: { senderRole: string; body: string; senderName: string; isSelf: boolean }[] };
    expect(customerBody.messages).toHaveLength(2);
    const dispatcherMsg = customerBody.messages.find((m) => m.senderRole === "dispatcher")!;
    expect(dispatcherMsg.body).toBe("On the way!");
    expect(dispatcherMsg.senderName).toBe("Dispatch");
    expect(dispatcherMsg.isSelf).toBe(false);
    const ownMsg = customerBody.messages.find((m) => m.senderRole === "customer")!;
    expect(ownMsg.isSelf).toBe(true);
    expect(ownMsg.senderName).toBe("You");
  });

  it("a rider sees only the conversation for their own assigned job, never another rider's", async () => {
    const customer = await makeCustomer(harness);
    const { rider: riderA, token: tokenA } = await makeRider(harness);
    const { rider: riderB, token: tokenB } = await makeRider(harness);
    const jobA = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, riderId: riderA.id, status: "accepted" } });
    void riderB;

    const send = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${jobA.id}/messages`, headers: { authorization: `Bearer ${tokenA}` }, payload: { body: "Heading to you now" } });
    expect(send.statusCode).toBe(200);

    const ownRead = await harness.app.inject({ method: "GET", url: `/api/bearer/jobs/${jobA.id}/messages`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(ownRead.statusCode).toBe(200);

    const otherRead = await harness.app.inject({ method: "GET", url: `/api/bearer/jobs/${jobA.id}/messages`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(otherRead.statusCode).toBe(403);
    const otherSend = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${jobA.id}/messages`, headers: { authorization: `Bearer ${tokenB}` }, payload: { body: "not my job" } });
    expect(otherSend.statusCode).toBe(403);
  });

  it("an accountant/viewer can monitor (read) but not respond (write)", async () => {
    const customer = await makeCustomer(harness);
    const { job } = await makeJobWithLink(harness, customer.id);
    const accountant = await staffToken(harness, "accountant");
    const viewer = await staffToken(harness, "viewer");

    for (const tok of [accountant, viewer]) {
      const read = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages`, headers: { authorization: `Bearer ${tok}` } });
      expect(read.statusCode).toBe(200);
      const write = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/messages`, headers: { authorization: `Bearer ${tok}` }, payload: { body: "trying to respond" } });
      expect(write.statusCode).toBe(403);
    }
  });
});

describe("conversation closure", () => {
  it("closes to new messages once the job reaches a terminal status, for both staff and rider", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, riderId: rider.id, status: "delivered" } });
    const dispatcherTok = await staffToken(harness, "dispatcher");

    const staffSend = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/messages`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: { body: "hello" } });
    expect(staffSend.statusCode).toBe(409);
    const riderSend = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/messages`, headers: { authorization: `Bearer ${riderTok}` }, payload: { body: "hello" } });
    expect(riderSend.statusCode).toBe(409);

    // History still readable by staff for audit purposes.
    const staffRead = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect(staffRead.statusCode).toBe(200);
    const body = staffRead.json() as { open: boolean };
    expect(body.open).toBe(false);
  });

  it("closes to the customer once the tracking link has expired (read-only history remains)", async () => {
    const customer = await makeCustomer(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, status: "assigned" } });
    const link = await harness.prisma.trackingLink.create({ data: { jobId: job.id, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() - 1000) } });

    const read = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages` });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { open: boolean }).open).toBe(false);
    const send = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages`, payload: { body: "still there?" } });
    expect(send.statusCode).toBe(409);
  });

  it("a revoked tracking link blocks the conversation entirely (410), not just writes", async () => {
    const customer = await makeCustomer(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, status: "assigned" } });
    const link = await harness.prisma.trackingLink.create({ data: { jobId: job.id, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000), revoked: true } });

    const read = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages` });
    expect(read.statusCode).toBe(410);
  });
});

describe("address change requests: reviewed, never silently applied", () => {
  it("a customer's proposed address is not applied until dispatch explicitly approves it", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id, { addressText: "Original Address" });
    const dispatcherTok = await staffToken(harness, "dispatcher");

    const propose = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/address-change`, payload: { proposedAddressText: "New Requested Address" } });
    expect(propose.statusCode).toBe(200);
    const proposed = propose.json() as { id: string; status: string };
    expect(proposed.status).toBe("pending");

    const jobAfterPropose = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfterPropose.addressText).toBe("Original Address"); // untouched

    const list = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/address-change-requests`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect((list.json() as { requests: unknown[] }).requests).toHaveLength(1);

    const approve = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/address-change-requests/${proposed.id}/approve`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: {} });
    expect(approve.statusCode).toBe(200);
    expect((approve.json() as { status: string }).status).toBe("approved");

    const jobAfterApprove = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfterApprove.addressText).toBe("New Requested Address");

    // Audited via a JobEvent.
    const events = await harness.prisma.jobEvent.findMany({ where: { jobId: job.id } });
    expect(events.some((e) => e.note?.includes("Address changed"))).toBe(true);

    // A confirmation system message was posted to the conversation.
    const messages = await harness.prisma.deliveryMessage.findMany({ where: { jobId: job.id } });
    expect(messages.some((m) => m.senderRole === "system" && m.body.includes("confirmed"))).toBe(true);
  });

  it("a declined request never touches the job's address, and cannot be reviewed twice", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id, { addressText: "Keep This Address" });
    const dispatcherTok = await staffToken(harness, "dispatcher");

    const propose = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/address-change`, payload: { proposedAddressText: "Rejected Address" } });
    const proposed = propose.json() as { id: string };

    const decline = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/address-change-requests/${proposed.id}/decline`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: { note: "doesn't match zone" } });
    expect(decline.statusCode).toBe(200);
    expect((decline.json() as { status: string }).status).toBe("declined");

    const jobRow = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobRow.addressText).toBe("Keep This Address");

    const reReview = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/address-change-requests/${proposed.id}/approve`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: {} });
    expect(reReview.statusCode).toBe(409);
  });

  it("a rider can also propose an address change, subject to the same review", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, riderId: rider.id, status: "accepted", addressText: "Old" } });

    const propose = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/address-change`, headers: { authorization: `Bearer ${riderTok}` }, payload: { proposedAddressText: "Rider Suggested Address" } });
    expect(propose.statusCode).toBe(200);
    const body = propose.json() as { requestedByRole: string; status: string };
    expect(body.requestedByRole).toBe("rider");
    expect(body.status).toBe("pending");

    const jobRow = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobRow.addressText).toBe("Old");
  });
});

describe("abuse protection and validation", () => {
  it("rejects a message over the length limit", async () => {
    const customer = await makeCustomer(harness);
    const { link } = await makeJobWithLink(harness, customer.id);
    const res = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages`, payload: { body: "x".repeat(1001) } });
    expect(res.statusCode).toBe(400);
  });

  it("rate-limits a burst of messages from the same sender on the same job", async () => {
    const customer = await makeCustomer(harness);
    const { link } = await makeJobWithLink(harness, customer.id);
    let lastStatus = 200;
    for (let i = 0; i < 20; i++) {
      const res = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages`, payload: { body: `message ${i}` } });
      lastStatus = res.statusCode;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("no PIN or phone-number leakage", () => {
  it("message DTOs never carry a phone number or the delivery PIN", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id, { pin: "9876" });
    const dispatcherTok = await staffToken(harness, "dispatcher");
    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages`, payload: { body: "hello" } });

    const res = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("9876");
    expect(raw).not.toContain(customer.phone);
    expect(raw.toLowerCase()).not.toContain("phone");
  });
});

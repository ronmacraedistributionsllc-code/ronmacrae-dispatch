/**
 * Delivery messaging (Stage 24 / spec 5): three real pairwise
 * conversations (customer↔dispatch, customer↔rider, rider↔dispatch)
 * replacing the old single shared thread (Stage 18). Real Fastify app +
 * real sqlite db.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeCustomer(h: TestHarness) {
  return h.prisma.customer.create({ data: { businessId: h.business.id, name: "Msg Test Customer", phone: `+1876572${uniq()}` } });
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
  const job = await h.prisma.job.create({ data: { businessId: h.business.id, customerId, status: "assigned", ...overrides } });
  const link = await h.prisma.trackingLink.create({ data: { jobId: job.id, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000) } });
  return { job, link };
}

beforeAll(async () => {
  harness = await buildTestHarness("test-delivery-messages");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("three distinct conversations, not one shared thread", () => {
  it("a customer_dispatch message is invisible in customer_rider, and vice versa", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id, { riderId: rider.id });
    const dispatcherTok = await staffToken(harness, "dispatcher");

    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "To dispatch" } });
    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_rider`, payload: { body: "To the rider" } });

    const dispatchView = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages/customer_dispatch` });
    const dispatchBodies = (dispatchView.json() as { messages: { body: string }[] }).messages.map((m) => m.body);
    expect(dispatchBodies).toEqual(["To dispatch"]);

    const riderView = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages/customer_rider` });
    const riderBodies = (riderView.json() as { messages: { body: string }[] }).messages.map((m) => m.body);
    expect(riderBodies).toEqual(["To the rider"]);

    // The rider only ever sees customer_rider, never customer_dispatch.
    const riderSees = await harness.app.inject({ method: "GET", url: `/api/bearer/jobs/${job.id}/messages/customer_rider`, headers: { authorization: `Bearer ${riderTok}` } });
    expect((riderSees.json() as { messages: { body: string }[] }).messages.map((m) => m.body)).toEqual(["To the rider"]);
    const riderForbidden = await harness.app.inject({ method: "GET", url: `/api/bearer/jobs/${job.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${riderTok}` } });
    expect(riderForbidden.statusCode).toBe(404);

    // Staff can read all three (monitor), including customer_rider.
    const staffMonitorsCustomerRider = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/customer_rider`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect(staffMonitorsCustomerRider.statusCode).toBe(200);
    expect((staffMonitorsCustomerRider.json() as { messages: { body: string }[] }).messages.map((m) => m.body)).toEqual(["To the rider"]);
  });

  it("staff can never write into customer_rider — monitor only, 403", async () => {
    const customer = await makeCustomer(harness);
    const { rider } = await makeRider(harness);
    const { job } = await makeJobWithLink(harness, customer.id, { riderId: rider.id });
    const dispatcherTok = await staffToken(harness, "dispatcher");

    const res = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/messages/customer_rider`,
      headers: { authorization: `Bearer ${dispatcherTok}` },
      payload: { body: "staff trying to post into customer<->rider" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a customer can write into both of their own conversations; a rider into both of theirs", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id, { riderId: rider.id });

    const customerToDispatch = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "c->d" } });
    const customerToRider = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_rider`, payload: { body: "c->r" } });
    expect(customerToDispatch.statusCode).toBe(200);
    expect(customerToRider.statusCode).toBe(200);

    const riderToCustomer = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/messages/customer_rider`, headers: { authorization: `Bearer ${riderTok}` }, payload: { body: "r->c" } });
    const riderToDispatch = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/messages/rider_dispatch`, headers: { authorization: `Bearer ${riderTok}` }, payload: { body: "r->d" } });
    expect(riderToCustomer.statusCode).toBe(200);
    expect(riderToDispatch.statusCode).toBe(200);
  });

  it("an unknown conversation kind 404s, for every side", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id);
    const dispatcherTok = await staffToken(harness, "dispatcher");
    const res = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages/not_a_real_kind` });
    expect(res.statusCode).toBe(404);
    const staffRes = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/not_a_real_kind`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect(staffRes.statusCode).toBe(404);
  });

  it("a rider sees only the conversations for their own assigned job, never another rider's", async () => {
    const customer = await makeCustomer(harness);
    const { rider: riderA, token: tokenA } = await makeRider(harness);
    const { token: tokenB } = await makeRider(harness);
    const jobA = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: riderA.id, status: "accepted" } });

    const send = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${jobA.id}/messages/rider_dispatch`, headers: { authorization: `Bearer ${tokenA}` }, payload: { body: "Heading to you now" } });
    expect(send.statusCode).toBe(200);

    const ownRead = await harness.app.inject({ method: "GET", url: `/api/bearer/jobs/${jobA.id}/messages/rider_dispatch`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(ownRead.statusCode).toBe(200);

    const otherRead = await harness.app.inject({ method: "GET", url: `/api/bearer/jobs/${jobA.id}/messages/rider_dispatch`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(otherRead.statusCode).toBe(403);
    const otherSend = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${jobA.id}/messages/rider_dispatch`, headers: { authorization: `Bearer ${tokenB}` }, payload: { body: "not my job" } });
    expect(otherSend.statusCode).toBe(403);
  });

  it("an accountant/viewer can monitor (read) every conversation but not respond (write) to any", async () => {
    const customer = await makeCustomer(harness);
    const { rider } = await makeRider(harness);
    const { job } = await makeJobWithLink(harness, customer.id, { riderId: rider.id });
    const accountant = await staffToken(harness, "accountant");
    const viewer = await staffToken(harness, "viewer");

    for (const tok of [accountant, viewer]) {
      for (const kind of ["customer_dispatch", "customer_rider", "rider_dispatch"]) {
        const read = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/${kind}`, headers: { authorization: `Bearer ${tok}` } });
        expect(read.statusCode).toBe(200);
        const write = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/messages/${kind}`, headers: { authorization: `Bearer ${tok}` }, payload: { body: "trying to respond" } });
        expect(write.statusCode).toBe(403);
      }
    }
  });
});

describe("legacy archive", () => {
  it("a pre-Stage-24 message (conversationKind: null) is readable via the legacy endpoint, and nowhere else", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id);
    const dispatcherTok = await staffToken(harness, "dispatcher");
    await harness.prisma.deliveryMessage.create({ data: { jobId: job.id, conversationKind: null, senderRole: "dispatcher", body: "old shared-thread message" } });

    const legacy = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/legacy`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect(legacy.statusCode).toBe(200);
    expect((legacy.json() as { messages: { body: string }[] }).messages.map((m) => m.body)).toEqual(["old shared-thread message"]);

    const customerLegacy = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages/legacy` });
    expect((customerLegacy.json() as { messages: { body: string }[] }).messages.map((m) => m.body)).toEqual(["old shared-thread message"]);

    const dispatchConversation = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect((dispatchConversation.json() as { messages: unknown[] }).messages).toEqual([]);
  });
});

describe("delivered/read receipts and unread counts", () => {
  it("a message starts undelivered/unread, and both flip once the recipient loads the conversation", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id);
    const dispatcherTok = await staffToken(harness, "dispatcher");

    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "hi" } });
    const beforeRead = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages/customer_dispatch` });
    const ownMsg = (beforeRead.json() as { messages: { isSelf: boolean; delivered: boolean; read: boolean }[] }).messages[0]!;
    expect(ownMsg.isSelf).toBe(true);
    expect(ownMsg.delivered).toBe(false);
    expect(ownMsg.read).toBe(false);

    await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherTok}` } });

    const afterRead = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages/customer_dispatch` });
    const seenMsg = (afterRead.json() as { messages: { delivered: boolean; read: boolean }[] }).messages[0]!;
    expect(seenMsg.delivered).toBe(true);
    expect(seenMsg.read).toBe(true);
  });

  it("staff monitoring customer_rider never marks it read, and never counts toward their own unread badge", async () => {
    const customer = await makeCustomer(harness);
    const { rider } = await makeRider(harness);
    const { job } = await makeJobWithLink(harness, customer.id, { riderId: rider.id });
    const dispatcherTok = await staffToken(harness, "dispatcher");

    await harness.prisma.deliveryMessage.create({ data: { jobId: job.id, conversationKind: "customer_rider", senderRole: "customer", body: "hi rider" } });

    await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/customer_rider`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    const row = await harness.prisma.deliveryMessage.findFirst({ where: { jobId: job.id, conversationKind: "customer_rider" } });
    expect(row?.readAt).toBeNull();

    const summary = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/conversations`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    const customerRider = (summary.json() as { conversations: { kind: string; canWrite: boolean; unreadCount: number }[] }).conversations.find((c) => c.kind === "customer_rider")!;
    expect(customerRider.canWrite).toBe(false);
    expect(customerRider.unreadCount).toBe(0);
  });

  it("unread counts show up in the conversations summary and clear once read", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id);
    const dispatcherTok = await staffToken(harness, "dispatcher");

    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "one" } });
    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "two" } });

    const before = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/conversations`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    const beforeKind = (before.json() as { conversations: { kind: string; unreadCount: number }[] }).conversations.find((c) => c.kind === "customer_dispatch")!;
    expect(beforeKind.unreadCount).toBe(2);

    await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherTok}` } });

    const after = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/conversations`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    const afterKind = (after.json() as { conversations: { kind: string; unreadCount: number }[] }).conversations.find((c) => c.kind === "customer_dispatch")!;
    expect(afterKind.unreadCount).toBe(0);
  });
});

describe("retry without duplicates", () => {
  it("resending the same clientToken returns the already-sent message instead of creating a duplicate", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id);
    const dispatcherTok = await staffToken(harness, "dispatcher");
    const clientToken = `retry-${uniq()}`;

    const first = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "flaky network", clientToken } });
    const second = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "flaky network", clientToken } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const rows = await harness.prisma.deliveryMessage.findMany({ where: { jobId: job.id, conversationKind: "customer_dispatch" } });
    expect(rows).toHaveLength(1);

    const view = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect((view.json() as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("the same clientToken in two different conversations is not treated as the same message", async () => {
    const customer = await makeCustomer(harness);
    const { rider } = await makeRider(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id, { riderId: rider.id });
    const clientToken = `cross-conv-${uniq()}`;

    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "to dispatch", clientToken } });
    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_rider`, payload: { body: "to rider", clientToken } });

    const rows = await harness.prisma.deliveryMessage.findMany({ where: { jobId: job.id } });
    expect(rows).toHaveLength(2);
  });
});

describe("address change requests fan out to the right conversations", () => {
  it("an approved address change posts a system message into customer_dispatch and rider_dispatch (rider assigned), never customer_rider", async () => {
    const customer = await makeCustomer(harness);
    const { rider } = await makeRider(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id, { riderId: rider.id, addressText: "Original" });
    const dispatcherTok = await staffToken(harness, "dispatcher");

    const propose = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/address-change`, payload: { proposedAddressText: "New Address" } });
    const proposed = propose.json() as { id: string };
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/address-change-requests/${proposed.id}/approve`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: {} });

    // Two system messages exist in a full propose->approve cycle (the
    // request itself, then the decision) — only the decision's is being
    // checked here for which conversations it fans out to.
    const confirmations = await harness.prisma.deliveryMessage.findMany({ where: { jobId: job.id, senderRole: "system", body: { contains: "confirmed" } } });
    const kinds = confirmations.map((m) => m.conversationKind).sort();
    expect(kinds).toEqual(["customer_dispatch", "rider_dispatch"]);
  });

  it("with no rider assigned, the system message only reaches customer_dispatch", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id, { addressText: "Original", riderId: null, status: "new" });
    const dispatcherTok = await staffToken(harness, "dispatcher");

    const propose = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/address-change`, payload: { proposedAddressText: "New Address" } });
    const proposed = propose.json() as { id: string };
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/address-change-requests/${proposed.id}/decline`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: {} });

    const systemMessages = await harness.prisma.deliveryMessage.findMany({ where: { jobId: job.id, senderRole: "system" } });
    // Both the request and the decline land only on customer_dispatch —
    // no rider is assigned, so rider_dispatch never gets a copy.
    expect(systemMessages.every((m) => m.conversationKind === "customer_dispatch")).toBe(true);
    expect(systemMessages.length).toBeGreaterThanOrEqual(2);
  });
});

describe("conversation closure", () => {
  it("closes to new messages once the job reaches a terminal status, for both staff and rider", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered" } });
    const dispatcherTok = await staffToken(harness, "dispatcher");

    const staffSend = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: { body: "hello" } });
    expect(staffSend.statusCode).toBe(409);
    const riderSend = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/messages/rider_dispatch`, headers: { authorization: `Bearer ${riderTok}` }, payload: { body: "hello" } });
    expect(riderSend.statusCode).toBe(409);

    // History still readable by staff for audit purposes.
    const staffRead = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect(staffRead.statusCode).toBe(200);
    const body = staffRead.json() as { open: boolean };
    expect(body.open).toBe(false);
  });

  it("customer_rider stays open for 24 hours after delivery, unlike every other conversation (spec item 5)", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const recentlyDelivered = await harness.prisma.job.create({
      data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered", completedAt: new Date(Date.now() - 60_000) },
    });
    const link = await harness.prisma.trackingLink.create({ data: { jobId: recentlyDelivered.id, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000) } });

    // Still well inside the 24h window: both sides can still send.
    const riderSend = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${recentlyDelivered.id}/messages/customer_rider`,
      headers: { authorization: `Bearer ${riderTok}` },
      payload: { body: "left it at the gate" },
    });
    expect(riderSend.statusCode).toBe(200);
    const customerSend = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_rider`, payload: { body: "thanks!" } });
    expect(customerSend.statusCode).toBe(200);

    // But every OTHER conversation on the same job is already closed —
    // the grace period is customer_rider-only.
    const dispatchSend = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${recentlyDelivered.id}/messages/rider_dispatch`,
      headers: { authorization: `Bearer ${riderTok}` },
      payload: { body: "hello" },
    });
    expect(dispatchSend.statusCode).toBe(409);

    // Now the same delivery, but completed more than 24h ago: closed for
    // both sides, history intact.
    const longDelivered = await harness.prisma.job.create({
      data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered", completedAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });
    const oldLink = await harness.prisma.trackingLink.create({ data: { jobId: longDelivered.id, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000) } });
    const staleRiderSend = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${longDelivered.id}/messages/customer_rider`,
      headers: { authorization: `Bearer ${riderTok}` },
      payload: { body: "too late" },
    });
    expect(staleRiderSend.statusCode).toBe(409);
    const staleCustomerRead = await harness.app.inject({ method: "GET", url: `/api/tracking/${oldLink.token}/messages/customer_rider` });
    expect(staleCustomerRead.statusCode).toBe(200);
    expect((staleCustomerRead.json() as { open: boolean }).open).toBe(false);
  });

  it("closes to the customer once the tracking link has expired (read-only history remains)", async () => {
    const customer = await makeCustomer(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, status: "assigned" } });
    const link = await harness.prisma.trackingLink.create({ data: { jobId: job.id, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() - 1000) } });

    const read = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages/customer_dispatch` });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { open: boolean }).open).toBe(false);
    const send = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "still there?" } });
    expect(send.statusCode).toBe(409);
  });

  it("a revoked tracking link blocks the conversation entirely (410), not just writes", async () => {
    const customer = await makeCustomer(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, status: "assigned" } });
    const link = await harness.prisma.trackingLink.create({ data: { jobId: job.id, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000), revoked: true } });

    const read = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages/customer_dispatch` });
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
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "accepted", addressText: "Old" } });

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
    const res = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "x".repeat(1001) } });
    expect(res.statusCode).toBe(400);
  });

  it("rate-limits a burst of messages from the same sender in the same conversation", async () => {
    const customer = await makeCustomer(harness);
    const { link } = await makeJobWithLink(harness, customer.id);
    let lastStatus = 200;
    for (let i = 0; i < 20; i++) {
      const res = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: `message ${i}` } });
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
    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "hello" } });

    const res = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("9876");
    expect(raw).not.toContain(customer.phone);
    expect(raw.toLowerCase()).not.toContain("phone");
  });
});

// Placed last, matching multi-tenancy.test.ts's own convention: this is the
// one test in the file that puts the shared harness's app into a real
// listening state (needed for a genuine `ws` client, not just `.inject()`)
// and never closes it again — afterAll's harness.cleanup() handles that,
// same as every other suite.
describe("reassignment revokes realtime access (spec 5)", () => {
  it("a rider unassigned from a job stops receiving that job's live delivery messages, even with an already-open socket", async () => {
    const customer = await makeCustomer(harness);
    const { rider: riderA, token: tokenA } = await makeRider(harness);
    const { rider: riderB } = await makeRider(harness);
    // assignJob only allows reassigning a "new" or "assigned" job, not one
    // already "accepted" by its current rider.
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: riderA.id, status: "assigned" } });

    await harness.app.listen({ port: 0, host: "127.0.0.1" });
    const address = harness.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tokenA}`);
    try {
      await new Promise<void>((resolve, reject) => {
        wsA.once("open", () => resolve());
        wsA.once("error", reject);
      });
      // Give the hub a moment to register the connection and its active-job room.
      await new Promise((r) => setTimeout(r, 50));

      const received: unknown[] = [];
      wsA.on("message", (raw) => received.push(JSON.parse(String(raw))));

      const dispatcherTok = await staffToken(harness, "dispatcher");
      const reassign = await harness.app.inject({
        method: "POST",
        url: `/api/jobs/${job.id}/assignments`,
        headers: { authorization: `Bearer ${dispatcherTok}` },
        payload: { riderId: riderB.id, reason: "test reassignment" },
      });
      expect(reassign.statusCode).toBe(200);

      // A message sent after reassignment must never reach rider A's socket.
      await harness.app.inject({
        method: "POST",
        url: `/api/jobs/${job.id}/messages/rider_dispatch`,
        headers: { authorization: `Bearer ${dispatcherTok}` },
        payload: { body: "message meant for the NEW rider" },
      });
      await new Promise((r) => setTimeout(r, 100));

      const deliveryMessageEvents = received.filter((m) => (m as { type?: string }).type === "delivery_message");
      expect(deliveryMessageEvents).toHaveLength(0);
    } finally {
      wsA.close();
    }
  });
});

describe("push notification on a new dispatch-to-rider message (spec 67: must reach a backgrounded/closed app)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pushes the rider when dispatch messages them and they have no live socket right now — generic body, never the message text", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const { job } = await makeJobWithLink(harness, customer.id, { riderId: rider.id, jobNumber: "RM-900001" });
    const dispatcherTok = await staffToken(harness, "dispatcher");
    const sendToRider = vi.spyOn(harness.ctx.push, "sendToRider").mockResolvedValue(undefined);

    const res = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/messages/rider_dispatch`,
      headers: { authorization: `Bearer ${dispatcherTok}` },
      payload: { body: "Please confirm you're heading to the pickup now" },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 10)); // the push call is fire-and-forget

    expect(sendToRider).toHaveBeenCalledTimes(1);
    const [pushedRiderId, payload] = sendToRider.mock.calls[0]!;
    expect(pushedRiderId).toBe(rider.id);
    const body = JSON.stringify(payload);
    expect(body).not.toContain("Please confirm you're heading to the pickup now");
    expect(body).toContain("RM-900001");

    // Sanity: this really is the rider being messaged, not a fluke —
    // they can read it through their own face too.
    const read = await harness.app.inject({ method: "GET", url: `/api/bearer/jobs/${job.id}/messages/rider_dispatch`, headers: { authorization: `Bearer ${riderTok}` } });
    expect(read.statusCode).toBe(200);
  });

  it("never pushes for a customer_dispatch or customer_rider message — no rider recipient exists on those", async () => {
    const customer = await makeCustomer(harness);
    const { job, link } = await makeJobWithLink(harness, customer.id);
    const sendToRider = vi.spyOn(harness.ctx.push, "sendToRider").mockResolvedValue(undefined);

    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/messages/customer_dispatch`, payload: { body: "Where is my order?" } });
    await new Promise((r) => setTimeout(r, 10));

    expect(sendToRider).not.toHaveBeenCalled();
  });
});

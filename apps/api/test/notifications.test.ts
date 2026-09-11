/**
 * Customer lifecycle notifications (Stage 15 / spec 5D): real Fastify app +
 * real sqlite db + the memory notification provider (see test-app.ts).
 *
 * Covers: the two newly-wired triggers (order confirmed on the first
 * tracking link, heading-to-pickup on that rider stage), in_transit and
 * delivering now sending genuinely different messages, consent gating,
 * the new customer default, and the configurable-templates endpoints
 * (including that an unknown template name is rejected and only admins can
 * write them).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function dispatcherToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: "Dee Dispatcher", passwordHash: "unused-in-tests", role: "dispatcher" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "dispatcher" });
}
async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: "Ada Admin", passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin" });
}

async function makeRider(h: TestHarness) {
  const rider = await h.prisma.rider.create({ data: { name: "Notif Test Rider", phone: `+1876561${uniq()}`, active: true, status: "available" } });
  const user = await h.prisma.user.create({ data: { name: rider.name, passwordHash: "unused-in-tests", role: "rider" } });
  const token = await h.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, token };
}

async function messagesForJob(h: TestHarness, jobId: string) {
  return h.prisma.outboxMessage.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-notifications");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("new customers default to consentTracking: true", () => {
  it("a staff-created customer gets tracking notifications by default", async () => {
    const dispatcher = await dispatcherToken(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { name: "Consent Default Test", phone: `+18765${uniq()}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { customer: { consentTracking: boolean } };
    expect(body.customer.consentTracking).toBe(true);
  });
});

describe("order-confirmed notification", () => {
  it("fires once, the first time a tracking link is created, and not again on a refresh", async () => {
    const dispatcher = await dispatcherToken(harness);
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id,  name: "Order Confirm Customer", phone: `+1876562${uniq()}`, consentTracking: true } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, status: "new" } });

    const first = await harness.app.inject({ method: "POST", url: `/api/tracking/${job.id}`, headers: { authorization: `Bearer ${dispatcher}` } });
    expect(first.statusCode).toBe(200);
    let messages = await messagesForJob(harness, job.id);
    expect(messages.filter((m) => m.template === "order_confirmed")).toHaveLength(1);

    // A second call (well within the TTL) reuses the same link — no repeat message.
    const second = await harness.app.inject({ method: "POST", url: `/api/tracking/${job.id}`, headers: { authorization: `Bearer ${dispatcher}` } });
    expect(second.statusCode).toBe(200);
    messages = await messagesForJob(harness, job.id);
    expect(messages.filter((m) => m.template === "order_confirmed")).toHaveLength(1);
  });

  it("does not fire when the customer has not consented to tracking", async () => {
    const dispatcher = await dispatcherToken(harness);
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id,  name: "No Consent Customer", phone: `+1876563${uniq()}`, consentTracking: false } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, status: "new" } });

    const res = await harness.app.inject({ method: "POST", url: `/api/tracking/${job.id}`, headers: { authorization: `Bearer ${dispatcher}` } });
    expect(res.statusCode).toBe(200);
    const messages = await messagesForJob(harness, job.id);
    expect(messages).toHaveLength(0);
  });
});

describe("heading-to-pickup notification", () => {
  it("fires when the rider reports that stage", async () => {
    const dispatcher = await dispatcherToken(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id,  name: "Heading Test Customer", phone: `+1876564${uniq()}`, consentTracking: true } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, riderId: rider.id, status: "accepted" } });
    void dispatcher;

    const res = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/stage`, headers: { authorization: `Bearer ${riderTok}` }, payload: { stage: "heading_to_pickup" } });
    expect(res.statusCode).toBe(200);
    const messages = await messagesForJob(harness, job.id);
    expect(messages.filter((m) => m.template === "heading_to_pickup")).toHaveLength(1);
  });

  it("does not fire for the at_pickup stage (only heading_to_pickup is customer-visible)", async () => {
    const { rider, token: riderTok } = await makeRider(harness);
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id,  name: "At Pickup Test Customer", phone: `+1876565${uniq()}`, consentTracking: true } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, riderId: rider.id, status: "accepted" } });

    const res = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/stage`, headers: { authorization: `Bearer ${riderTok}` }, payload: { stage: "at_pickup" } });
    expect(res.statusCode).toBe(200);
    const messages = await messagesForJob(harness, job.id);
    expect(messages).toHaveLength(0);
  });
});

describe("in_transit vs. delivering send genuinely different messages", () => {
  it("uses distinct templates for 'in transit' and 'near destination'", async () => {
    const { rider, token: riderTok } = await makeRider(harness);
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id,  name: "Transit Test Customer", phone: `+1876566${uniq()}`, consentTracking: true } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, riderId: rider.id, status: "picked_up" } });

    const toTransit = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/transition`, headers: { authorization: `Bearer ${riderTok}` }, payload: { to: "in_transit" } });
    expect(toTransit.statusCode).toBe(200);
    const toDelivering = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/transition`, headers: { authorization: `Bearer ${riderTok}` }, payload: { to: "delivering" } });
    expect(toDelivering.statusCode).toBe(200);

    const messages = await messagesForJob(harness, job.id);
    const templates = messages.map((m) => m.template);
    expect(templates).toContain("out_for_delivery");
    expect(templates).toContain("near_destination");
    expect(templates.filter((t) => t === "out_for_delivery")).not.toEqual(templates.filter((t) => t === "near_destination"));
  });
});

describe("configurable message templates", () => {
  it("lists all built-in templates with overridden: false by default", async () => {
    const dispatcher = await dispatcherToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/notifications/templates", headers: { authorization: `Bearer ${dispatcher}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { templates: { name: string; overridden: boolean }[] };
    expect(body.templates.find((t) => t.name === "order_confirmed")?.overridden).toBe(false);
    expect(body.templates.map((t) => t.name)).toContain("heading_to_pickup");
    expect(body.templates.map((t) => t.name)).toContain("near_destination");
  });

  it("only an admin can write template overrides", async () => {
    const dispatcher = await dispatcherToken(harness);
    const res = await harness.app.inject({
      method: "PUT",
      url: "/api/notifications/templates",
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { templates: { delivered: "custom text" } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an unknown template name", async () => {
    const admin = await adminToken(harness);
    const res = await harness.app.inject({
      method: "PUT",
      url: "/api/notifications/templates",
      headers: { authorization: `Bearer ${admin}` },
      payload: { templates: { not_a_real_template: "custom text" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("persists a valid override and reflects it back as overridden: true", async () => {
    const admin = await adminToken(harness);
    const put = await harness.app.inject({
      method: "PUT",
      url: "/api/notifications/templates",
      headers: { authorization: `Bearer ${admin}` },
      payload: { templates: { delivered: "Custom: your order {{orderRef}} has arrived!" } },
    });
    expect(put.statusCode).toBe(200);
    const get = await harness.app.inject({ method: "GET", url: "/api/notifications/templates", headers: { authorization: `Bearer ${admin}` } });
    const body = get.json() as { templates: { name: string; body: string; overridden: boolean }[] };
    const delivered = body.templates.find((t) => t.name === "delivered")!;
    expect(delivered.overridden).toBe(true);
    expect(delivered.body).toBe("Custom: your order {{orderRef}} has arrived!");
  });

  it("saving one template's override never wipes out another's already-saved one", async () => {
    const admin = await adminToken(harness);
    const first = await harness.app.inject({
      method: "PUT",
      url: "/api/notifications/templates",
      headers: { authorization: `Bearer ${admin}` },
      payload: { templates: { picked_up: "Custom picked-up text" } },
    });
    expect(first.statusCode).toBe(200);

    // Save a *different* template — must not affect the one above.
    const second = await harness.app.inject({
      method: "PUT",
      url: "/api/notifications/templates",
      headers: { authorization: `Bearer ${admin}` },
      payload: { templates: { failed: "Custom failed text" } },
    });
    expect(second.statusCode).toBe(200);

    const get = await harness.app.inject({ method: "GET", url: "/api/notifications/templates", headers: { authorization: `Bearer ${admin}` } });
    const body = get.json() as { templates: { name: string; body: string; overridden: boolean }[] };
    expect(body.templates.find((t) => t.name === "picked_up")!.body).toBe("Custom picked-up text");
    expect(body.templates.find((t) => t.name === "failed")!.body).toBe("Custom failed text");
  });
});

describe("Twilio status webhook", () => {
  it("moves a 'sent' message to 'delivered' on a delivered callback, unsigned when no auth token is configured", async () => {
    const { rider } = await makeRider(harness);
    void rider;
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id,  name: "Webhook Test Customer", phone: `+1876567${uniq()}` } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, status: "new" } });
    const outbox = await harness.prisma.outboxMessage.create({
      data: { channel: "whatsapp", to: customer.phone, template: "delivered", params: {}, jobId: job.id, status: "sent", provider: "twilio", providerRef: `SMtest${uniq()}` },
    });

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/notifications/twilio-status",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `MessageSid=${outbox.providerRef}&MessageStatus=delivered`,
    });
    expect(res.statusCode).toBe(200);
    const updated = await harness.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outbox.id } });
    expect(updated.status).toBe("delivered");
  });

  it("moves a message to 'failed' on an undelivered callback, with the reason recorded", async () => {
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id,  name: "Webhook Fail Customer", phone: `+1876568${uniq()}` } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, status: "new" } });
    const outbox = await harness.prisma.outboxMessage.create({
      data: { channel: "sms", to: customer.phone, template: "delivered", params: {}, jobId: job.id, status: "sent", provider: "twilio", providerRef: `SMfail${uniq()}` },
    });

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/notifications/twilio-status",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `MessageSid=${outbox.providerRef}&MessageStatus=undelivered`,
    });
    expect(res.statusCode).toBe(200);
    const updated = await harness.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outbox.id } });
    expect(updated.status).toBe("failed");
    expect(updated.error).toContain("undelivered");
  });

  it("is harmless (200, no-op) for an unknown message id", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/notifications/twilio-status",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `MessageSid=SMdoesnotexist&MessageStatus=delivered`,
    });
    expect(res.statusCode).toBe(200);
  });
});

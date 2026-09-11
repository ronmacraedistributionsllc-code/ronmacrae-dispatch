/**
 * Cross-business customer package dashboard (Stage 22 / spec 4): phone-
 * verified access code, then GET /api/customer-dashboard aggregates every
 * business's Customer rows sharing that phone. Real Fastify app + real
 * sqlite db (see test/helpers/test-app.ts).
 *
 * The plaintext code is never returned by any API response — tests read it
 * the same way notifications.test.ts already reads other outbound message
 * content: directly off the OutboxMessage row's params, exactly what a real
 * SMS provider would have been handed to deliver.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { normalizePhoneJM, toNotifyAddress } from "../src/lib/phone.js";

let harness: TestHarness;
let businessB: { id: string; name: string };
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function latestCode(h: TestHarness, phone: string): Promise<string> {
  const row = await h.prisma.outboxMessage.findFirst({
    where: { template: "customer_dashboard_code", to: toNotifyAddress(phone) },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw new Error("no code was sent");
  return (row.params as { code: string }).code;
}

async function requestAndVerify(h: TestHarness, rawPhone: string): Promise<string> {
  const phone = normalizePhoneJM(rawPhone)!;
  const req = await h.app.inject({ method: "POST", url: "/api/customer-dashboard/request-code", payload: { phone: rawPhone } });
  expect(req.statusCode).toBe(200);
  const code = await latestCode(h, phone);
  const verify = await h.app.inject({ method: "POST", url: "/api/customer-dashboard/verify", payload: { phone: rawPhone, code } });
  expect(verify.statusCode).toBe(200);
  return (verify.json() as { token: string }).token;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-customer-dashboard");
  businessB = await harness.prisma.business.create({ data: { name: "Business B Couriers", slug: `business-b-cd-${Date.now()}` } });
});

afterAll(async () => {
  await harness.cleanup();
});

describe("phone-verified access", () => {
  it("rejects a wrong code without consuming a correct one, and enforces a resend cooldown", async () => {
    const rawPhone = `876555${uniq()}`.slice(0, 10);
    const phone = normalizePhoneJM(rawPhone)!;

    const req1 = await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/request-code", payload: { phone: rawPhone } });
    expect(req1.statusCode).toBe(200);

    const req2 = await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/request-code", payload: { phone: rawPhone } });
    expect(req2.statusCode).toBe(429);

    const wrong = await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/verify", payload: { phone: rawPhone, code: "000000" } });
    expect(wrong.statusCode).toBe(400);

    const code = await latestCode(harness, phone);
    const right = await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/verify", payload: { phone: rawPhone, code } });
    expect(right.statusCode).toBe(200);
    expect((right.json() as { token: string }).token).toBeTruthy();

    // Already consumed — using it again fails even though it was correct.
    const reuse = await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/verify", payload: { phone: rawPhone, code } });
    expect(reuse.statusCode).toBe(400);
  });

  it("never exposes the customer-dashboard code through the staff notifications list (it has no owning business)", async () => {
    const rawPhone = `876556${uniq()}`.slice(0, 10);
    await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/request-code", payload: { phone: rawPhone } });

    const user = await harness.prisma.user.create({ data: { name: "Notif Admin", passwordHash: "unused-in-tests", role: "admin" } });
    const admin = await harness.tokenFor({ id: user.id, name: user.name, role: "admin" });
    const list = await harness.app.inject({ method: "GET", url: "/api/notifications?take=500", headers: { authorization: `Bearer ${admin}` } });
    const templates = (list.json() as { messages: { template: string }[] }).messages.map((m) => m.template);
    expect(templates).not.toContain("customer_dashboard_code");
  });

  it("rejects the dashboard route without a valid session token", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/customer-dashboard" });
    expect(res.statusCode).toBe(401);
    const bad = await harness.app.inject({ method: "GET", url: "/api/customer-dashboard", headers: { authorization: "Bearer not-a-real-token" } });
    expect(bad.statusCode).toBe(401);
  });
});

describe("cross-business aggregation", () => {
  it("lists one phone's packages from every business, splits active vs history, and restricts location the same way the tracking page does", async () => {
    const rawPhone = `876777${uniq()}`.slice(0, 10);

    const rider = await harness.prisma.rider.create({ data: { name: "Dash Test Rider", phone: `+1876778${uniq()}`, active: true, status: "available" } });
    await harness.prisma.riderLocation.create({
      data: { riderId: rider.id, point: { lat: 18.01, lng: -76.79 }, trackingState: "active", clientSeq: 1, at: new Date() },
    });

    // Business A (the harness's own business): an active, not-yet-picked-up job.
    const customerA = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Cross Biz Customer", phone: rawPhone } });
    const jobNew = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customerA.id, status: "new" } });

    // Business A again: a DELIVERED job with a rider and a fresh location row
    // on file — must NOT show a location (the restricted-display rule), even
    // though a naive "riderId is set" check would have shown one.
    const jobDelivered = await harness.prisma.job.create({
      data: { businessId: harness.business.id, customerId: customerA.id, riderId: rider.id, status: "delivered", pin: "1234" },
    });

    // Business B: a picked-up job, actively out with the rider — location
    // and PIN should both be visible.
    const customerB = await harness.prisma.customer.create({ data: { businessId: businessB.id, name: "Cross Biz Customer", phone: rawPhone } });
    const jobPickedUp = await harness.prisma.job.create({
      data: { businessId: businessB.id, customerId: customerB.id, riderId: rider.id, status: "picked_up", pin: "5678" },
    });

    const token = await requestAndVerify(harness, rawPhone);
    const res = await harness.app.inject({ method: "GET", url: "/api/customer-dashboard", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      active: { jobId: string; businessName: string; location: { point: unknown } | null; pin: string | null }[];
      history: { jobId: string; location: { point: unknown } | null; pin: string | null }[];
    };

    const activeIds = body.active.map((p) => p.jobId);
    const historyIds = body.history.map((p) => p.jobId);
    expect(activeIds).toContain(jobNew.id);
    expect(activeIds).toContain(jobPickedUp.id);
    expect(historyIds).toContain(jobDelivered.id);

    const pickedUpCard = body.active.find((p) => p.jobId === jobPickedUp.id)!;
    expect(pickedUpCard.location?.point).toEqual({ lat: 18.01, lng: -76.79 });
    expect(pickedUpCard.pin).toBe("5678");
    expect(pickedUpCard.businessName).toBe(businessB.name);

    const deliveredCard = body.history.find((p) => p.jobId === jobDelivered.id)!;
    expect(deliveredCard.location).toBeNull();
    expect(deliveredCard.pin).toBeNull();
  });

  it("returns nothing for a phone number with no orders, rather than an error", async () => {
    const rawPhone = `876999${uniq()}`.slice(0, 10);
    const token = await requestAndVerify(harness, rawPhone);
    const res = await harness.app.inject({ method: "GET", url: "/api/customer-dashboard", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { active: unknown[]; history: unknown[] };
    expect(body.active).toEqual([]);
    expect(body.history).toEqual([]);
  });
});

/**
 * Multi-tenancy foundation (Stage 20): business isolation across orders,
 * offers, messages, GPS, cash ledgers, reports and realtime subscriptions.
 * Real Fastify app + real sqlite db (see test/helpers/test-app.ts).
 *
 * The scenario throughout: two businesses, ONE rider shared between them
 * (an active RiderMembership at both) — the exact case the isolation rules
 * have to get right, since "belongs to a business" alone isn't enough for a
 * rider the way it is for a job/customer/offer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let businessB: { id: string; name: string };
let sharedRider: { id: string };
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function staffToken(businessId: string, role: "admin" | "dispatcher" | "accountant" | "viewer" = "dispatcher") {
  const user = await harness.prisma.user.create({ data: { name: `Staff ${uniq()}`, passwordHash: "unused-in-tests", role } });
  await harness.prisma.staffMembership.create({ data: { userId: user.id, businessId, role, active: true } });
  return harness.tokenFor({ id: user.id, name: user.name, role, businessId });
}

async function makeCustomer(businessId: string) {
  return harness.prisma.customer.create({ data: { businessId, name: "Isolation Test Customer", phone: `+1876${uniq()}` } });
}

async function makeJob(businessId: string, customerId: string, overrides: Record<string, unknown> = {}) {
  return harness.prisma.job.create({ data: { businessId, customerId, status: "new", ...overrides } });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-multi-tenancy");
  businessB = await harness.prisma.business.create({ data: { name: "Business B Couriers", slug: `business-b-${Date.now()}` } });

  // The shared rider: created (and so auto-membered) at the harness's own
  // business — call it Business A — then explicitly also given an active
  // membership at Business B, matching "two businesses sharing one rider".
  sharedRider = await harness.prisma.rider.create({ data: { name: "Shared Rider", phone: `+1876900${uniq()}`, active: true, status: "available", dailyCapacity: 10 } });
  await harness.prisma.riderMembership.create({ data: { riderId: sharedRider.id, businessId: businessB.id, status: "active", approvedAt: new Date() } });
});

afterAll(async () => {
  await harness.cleanup();
});

describe("orders", () => {
  it("a business's job list and single-job lookup never include another business's jobs, even carried by the same shared rider", async () => {
    const dispatcherA = await staffToken(harness.business.id);
    const dispatcherB = await staffToken(businessB.id);
    const jobA = await makeJob(harness.business.id, (await makeCustomer(harness.business.id)).id, { riderId: sharedRider.id, status: "assigned" });
    const jobB = await makeJob(businessB.id, (await makeCustomer(businessB.id)).id, { riderId: sharedRider.id, status: "assigned" });

    const listA = await harness.app.inject({ method: "GET", url: "/api/jobs", headers: { authorization: `Bearer ${dispatcherA}` } });
    const idsInA = (listA.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id);
    expect(idsInA).toContain(jobA.id);
    expect(idsInA).not.toContain(jobB.id);

    const listB = await harness.app.inject({ method: "GET", url: "/api/jobs", headers: { authorization: `Bearer ${dispatcherB}` } });
    const idsInB = (listB.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id);
    expect(idsInB).toContain(jobB.id);
    expect(idsInB).not.toContain(jobA.id);

    // Direct lookup by id — 404, not 403, so a business never even learns
    // that the other one's job exists.
    const crossGetFromA = await harness.app.inject({ method: "GET", url: `/api/jobs/${jobB.id}`, headers: { authorization: `Bearer ${dispatcherA}` } });
    expect(crossGetFromA.statusCode).toBe(404);
    const crossGetFromB = await harness.app.inject({ method: "GET", url: `/api/jobs/${jobA.id}`, headers: { authorization: `Bearer ${dispatcherB}` } });
    expect(crossGetFromB.statusCode).toBe(404);

    // Nor can a business transition/cancel the other's job.
    const crossCancel = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobB.id}/cancel`, headers: { authorization: `Bearer ${dispatcherA}` }, payload: {} });
    expect(crossCancel.statusCode).toBe(404);
  });
});

describe("offers", () => {
  it("only riders with an active membership at the broadcasting business are eligible — a shared rider is, an A-only rider at a B broadcast isn't", async () => {
    const dispatcherA = await staffToken(harness.business.id);
    const dispatcherB = await staffToken(businessB.id);
    // A rider who is a member of A only (created via the harness's default
    // auto-membership, never added to B).
    const aOnlyRider = await harness.prisma.rider.create({ data: { name: "A Only Rider", phone: `+1876901${uniq()}`, active: true, status: "available" } });

    const jobB = await makeJob(businessB.id, (await makeCustomer(businessB.id)).id, { status: "new" });
    const broadcast = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobB.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcherB}` }, payload: {} });
    expect(broadcast.statusCode).toBe(200);
    const eligibleRiderIds = (broadcast.json() as { offers: { riderId: string }[] }).offers.map((o) => o.riderId);
    expect(eligibleRiderIds).toContain(sharedRider.id); // member of B too — eligible
    expect(eligibleRiderIds).not.toContain(aOnlyRider.id); // never a member of B

    // Business A can never see or withdraw B's offer for its own job.
    const offersFromA = await harness.app.inject({ method: "GET", url: `/api/jobs/${jobB.id}/offers`, headers: { authorization: `Bearer ${dispatcherA}` } });
    expect((offersFromA.json() as { offers: unknown[] }).offers).toHaveLength(0);
  });
});

describe("messages", () => {
  it("a business can never read or write another business's delivery conversation", async () => {
    const dispatcherA = await staffToken(harness.business.id);
    const dispatcherB = await staffToken(businessB.id);
    const jobA = await makeJob(harness.business.id, (await makeCustomer(harness.business.id)).id, { riderId: sharedRider.id, status: "assigned" });

    const send = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobA.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherA}` }, payload: { body: "Business A's own message" } });
    expect(send.statusCode).toBe(200);

    const readFromB = await harness.app.inject({ method: "GET", url: `/api/jobs/${jobA.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherB}` } });
    expect(readFromB.statusCode).toBe(404);
    const writeFromB = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobA.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${dispatcherB}` }, payload: { body: "intruding" } });
    expect(writeFromB.statusCode).toBe(404);

    // The message never actually landed from B's attempt.
    const messages = await harness.prisma.deliveryMessage.findMany({ where: { jobId: jobA.id } });
    expect(messages.map((m) => m.body)).toEqual(["Business A's own message"]);
  });
});

describe("cash ledgers (COD)", () => {
  it("the COD reconciliation board and a job's COD event history are isolated per business", async () => {
    const dispatcherA = await staffToken(harness.business.id);
    const dispatcherB = await staffToken(businessB.id);
    const jobA = await makeJob(harness.business.id, (await makeCustomer(harness.business.id)).id, {
      riderId: sharedRider.id, status: "delivered", paymentMethod: "cod", amountExpected: 1000, currency: "JMD", codStatus: "collected",
    });

    const codListB = await harness.app.inject({ method: "GET", url: "/api/cod", headers: { authorization: `Bearer ${dispatcherB}` } });
    const idsInB = (codListB.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id);
    expect(idsInB).not.toContain(jobA.id);

    const codListA = await harness.app.inject({ method: "GET", url: "/api/cod", headers: { authorization: `Bearer ${dispatcherA}` } });
    const idsInA = (codListA.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id);
    expect(idsInA).toContain(jobA.id);

    const eventsFromB = await harness.app.inject({ method: "GET", url: `/api/jobs/${jobA.id}/cod/events`, headers: { authorization: `Bearer ${dispatcherB}` } });
    expect(eventsFromB.statusCode).toBe(404);

    const handInFromB = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobA.id}/cod/hand-in`, headers: { authorization: `Bearer ${dispatcherB}` }, payload: { amountHandedIn: 1000 } });
    expect(handInFromB.statusCode).toBe(404);
  });
});

describe("reports", () => {
  it("a business's operating report and CSV export never include another business's jobs", async () => {
    const accountantA = await staffToken(harness.business.id, "accountant");
    const jobA = await makeJob(harness.business.id, (await makeCustomer(harness.business.id)).id, { status: "delivered", completedAt: new Date() });
    const jobB = await makeJob(businessB.id, (await makeCustomer(businessB.id)).id, { status: "delivered", completedAt: new Date() });

    const res = await harness.app.inject({ method: "GET", url: "/api/reports/summary", headers: { authorization: `Bearer ${accountantA}` } });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { rows: { jobId: string }[] }).rows.map((r) => r.jobId);
    expect(ids).toContain(jobA.id);
    expect(ids).not.toContain(jobB.id);

    const csv = await harness.app.inject({ method: "GET", url: "/api/reports/jobs.csv", headers: { authorization: `Bearer ${accountantA}` } });
    expect(csv.body).not.toContain(jobB.id);
  });
});

describe("GPS", () => {
  it("a rider's live location is visible on a business's map only while they're an active member there — never to a business they've never worked with, even sharing a rider with someone else", async () => {
    const dispatcherA = await staffToken(harness.business.id);
    const dispatcherB = await staffToken(businessB.id);
    // A rider who is a member of A only (never added to B) — the dispatcher
    // map is meant to show any of your own available riders' positions, not
    // only ones already mid-delivery, so this is deliberately NOT on a job.
    const aOnlyRider = await harness.prisma.rider.create({ data: { name: "GPS A-Only Rider", phone: `+1876902${uniq()}`, active: true, status: "available" } });
    await harness.prisma.riderLocation.create({ data: { riderId: aOnlyRider.id, point: { lat: 18.0, lng: -76.8 }, trackingState: "active", clientSeq: 1, at: new Date() } });

    const locA = await harness.app.inject({ method: "GET", url: "/api/rider-locations", headers: { authorization: `Bearer ${dispatcherA}` } });
    expect((locA.json() as { locations: { riderId: string }[] }).locations.map((l) => l.riderId)).toContain(aOnlyRider.id);

    // B has never worked with this rider — B must not see their position.
    const locB = await harness.app.inject({ method: "GET", url: "/api/rider-locations", headers: { authorization: `Bearer ${dispatcherB}` } });
    expect((locB.json() as { locations: { riderId: string }[] }).locations.map((l) => l.riderId)).not.toContain(aOnlyRider.id);

    // Once B actually brings this rider into their own network (an active
    // membership — not merely reusing the fixture), B gains visibility too —
    // and A never loses theirs, matching the shared-rider scenario overall.
    await harness.prisma.riderMembership.create({ data: { riderId: aOnlyRider.id, businessId: businessB.id, status: "active", approvedAt: new Date() } });
    const locBAfter = await harness.app.inject({ method: "GET", url: "/api/rider-locations", headers: { authorization: `Bearer ${dispatcherB}` } });
    expect((locBAfter.json() as { locations: { riderId: string }[] }).locations.map((l) => l.riderId)).toContain(aOnlyRider.id);
    const locAAfter = await harness.app.inject({ method: "GET", url: "/api/rider-locations", headers: { authorization: `Bearer ${dispatcherA}` } });
    expect((locAAfter.json() as { locations: { riderId: string }[] }).locations.map((l) => l.riderId)).toContain(aOnlyRider.id);
  });
});

describe("realtime subscriptions", () => {
  it("a job-state broadcast for one business's job reaches only that business's dispatch socket, never the other's", async () => {
    await harness.app.listen({ port: 0, host: "127.0.0.1" });
    const address = harness.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const dispatcherA = await staffToken(harness.business.id);
    const dispatcherB = await staffToken(businessB.id);
    const jobA = await makeJob(harness.business.id, (await makeCustomer(harness.business.id)).id, { status: "assigned", riderId: sharedRider.id });

    const connect = (token: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
    const wsA = await connect(dispatcherA);
    const wsB = await connect(dispatcherB);
    try {
      const messagesA: { type: string; payload?: { job?: { id?: string } } }[] = [];
      const messagesB: typeof messagesA = [];
      wsA.on("message", (raw) => messagesA.push(JSON.parse(String(raw))));
      wsB.on("message", (raw) => messagesB.push(JSON.parse(String(raw))));
      await new Promise((r) => setTimeout(r, 150)); // let both "hello" frames land

      const cancel = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobA.id}/cancel`, headers: { authorization: `Bearer ${dispatcherA}` }, payload: {} });
      expect(cancel.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 250));

      expect(messagesA.some((m) => m.type === "job.state" && m.payload?.job?.id === jobA.id)).toBe(true);
      expect(messagesB.some((m) => m.type === "job.state" && m.payload?.job?.id === jobA.id)).toBe(false);

      // B's socket can't even explicitly join A's job room by guessing its id.
      wsB.send(JSON.stringify({ type: "join", rooms: [`job:${jobA.id}`] }));
      await new Promise((r) => setTimeout(r, 150));
      const joined = messagesB.find((m) => m.type === "joined") as { rooms?: string[] } | undefined;
      expect(joined?.rooms ?? []).not.toContain(`job:${jobA.id}`);
    } finally {
      wsA.close();
      wsB.close();
    }
  });
});

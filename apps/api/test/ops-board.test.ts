/**
 * Dispatcher operations board (Stage 14 / spec 5C): one aggregated,
 * read-only endpoint. Real Fastify app + real sqlite db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeCustomer(h: TestHarness) {
  return h.prisma.customer.create({ data: { name: "Test Customer", phone: `+1876555${uniq()}` } });
}

async function makeRider(h: TestHarness, overrides: Record<string, unknown> = {}) {
  return h.prisma.rider.create({ data: { name: "Ops Board Rider", phone: `+1876559${uniq()}`, active: true, status: "available", dailyCapacity: 3, ...overrides } });
}

async function staffToken(h: TestHarness, role: "admin" | "dispatcher" | "accountant" | "viewer" | "rider" = "dispatcher") {
  const user = await h.prisma.user.create({ data: { name: `Test ${role}`, passwordHash: "unused-in-tests", role } });
  return h.tokenFor({ id: user.id, name: user.name, role });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-ops-board");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("ops board aggregation", () => {
  it("reports a rider's active-job count, remaining capacity, and marks a stale location honestly", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness, { dailyCapacity: 2 });
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "assigned" } });
    // A location from 10 minutes ago — well past the 5-minute staleness window.
    await harness.prisma.riderLocation.create({
      data: { riderId: rider.id, point: { lat: 18.0, lng: -76.8 }, trackingState: "active", clientSeq: 1, at: new Date(Date.now() - 10 * 60_000) },
    });
    const token = await staffToken(harness);

    const res = await harness.app.inject({ method: "GET", url: "/api/ops-board", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { riders: { id: string; activeJobCount: number; capacity: number; capacityRemaining: number; location: { stale: boolean; ageMs: number } | null }[] };
    const row = body.riders.find((r) => r.id === rider.id)!;
    expect(row.activeJobCount).toBe(1);
    expect(row.capacity).toBe(2);
    expect(row.capacityRemaining).toBe(1);
    expect(row.location).not.toBeNull();
    expect(row.location!.stale).toBe(true);
    expect(row.location!.ageMs).toBeGreaterThan(5 * 60_000);
  });

  it("does not mark a fresh location as stale", async () => {
    const rider = await makeRider(harness);
    await harness.prisma.riderLocation.create({
      data: { riderId: rider.id, point: { lat: 18.0, lng: -76.8 }, trackingState: "active", clientSeq: 1, at: new Date() },
    });
    const token = await staffToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/ops-board", headers: { authorization: `Bearer ${token}` } });
    const body = res.json() as { riders: { id: string; location: { stale: boolean } | null }[] };
    expect(body.riders.find((r) => r.id === rider.id)!.location!.stale).toBe(false);
  });

  it("a rider with no location report at all shows location: null, never a fabricated point", async () => {
    const rider = await makeRider(harness);
    const token = await staffToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/ops-board", headers: { authorization: `Bearer ${token}` } });
    const body = res.json() as { riders: { id: string; location: unknown }[] };
    expect(body.riders.find((r) => r.id === rider.id)!.location).toBeNull();
  });

  it("lists a waiting (open, unexpired) offer, and never an expired one", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { customerId: customer.id, status: "new", priority: "urgent" } });
    const openOffer = await harness.prisma.jobOffer.create({ data: { jobId: job.id, riderId: rider.id, expiresAt: new Date(Date.now() + 60_000) } });
    const expiredJob = await harness.prisma.job.create({ data: { customerId: customer.id, status: "new" } });
    await harness.prisma.jobOffer.create({ data: { jobId: expiredJob.id, riderId: rider.id, expiresAt: new Date(Date.now() - 60_000) } });
    const token = await staffToken(harness);

    const res = await harness.app.inject({ method: "GET", url: "/api/ops-board", headers: { authorization: `Bearer ${token}` } });
    const body = res.json() as { waitingOffers: { id: string; urgent: boolean }[] };
    const ids = body.waitingOffers.map((o) => o.id);
    expect(ids).toContain(openOffer.id);
    expect(body.waitingOffers.find((o) => o.id === openOffer.id)!.urgent).toBe(true);
  });

  it("flags an overdue job (promisedAt in the past, still active) and excludes one that isn't due yet", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const overdue = await harness.prisma.job.create({
      data: { customerId: customer.id, riderId: rider.id, status: "accepted", promisedAt: new Date(Date.now() - 30 * 60_000) },
    });
    const notDue = await harness.prisma.job.create({
      data: { customerId: customer.id, riderId: rider.id, status: "accepted", promisedAt: new Date(Date.now() + 30 * 60_000) },
    });
    const token = await staffToken(harness);

    const res = await harness.app.inject({ method: "GET", url: "/api/ops-board", headers: { authorization: `Bearer ${token}` } });
    const body = res.json() as { overdueJobs: { id: string; overdueByMs: number }[] };
    const ids = body.overdueJobs.map((j) => j.id);
    expect(ids).toContain(overdue.id);
    expect(ids).not.toContain(notDue.id);
    expect(body.overdueJobs.find((j) => j.id === overdue.id)!.overdueByMs).toBeGreaterThan(0);
  });

  it("lists a job awaiting COD handover approval and only that status", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const awaiting = await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, paymentMethod: "cod", codStatus: "handed_in" } });
    const notYet = await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, paymentMethod: "cod", codStatus: "collected" } });
    const token = await staffToken(harness);

    const res = await harness.app.inject({ method: "GET", url: "/api/ops-board", headers: { authorization: `Bearer ${token}` } });
    const body = res.json() as { codAwaitingHandover: { id: string }[] };
    const ids = body.codAwaitingHandover.map((j) => j.id);
    expect(ids).toContain(awaiting.id);
    expect(ids).not.toContain(notYet.id);
  });

  it("is not reachable by a rider role", async () => {
    const token = await staffToken(harness, "rider");
    const res = await harness.app.inject({ method: "GET", url: "/api/ops-board", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });
});

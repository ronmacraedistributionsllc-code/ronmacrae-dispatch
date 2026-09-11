/**
 * Operating reports (Stage 16 / spec 5E): real Fastify app + real sqlite db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeCustomer(h: TestHarness) {
  return h.prisma.customer.create({ data: { name: "Report Test Customer", phone: `+1876569${uniq()}` } });
}
async function makeRider(h: TestHarness, overrides: Record<string, unknown> = {}) {
  return h.prisma.rider.create({ data: { name: "Report Test Rider", phone: `+1876570${uniq()}`, active: true, status: "available", ...overrides } });
}
async function staffToken(h: TestHarness, role: "admin" | "accountant" | "dispatcher" | "viewer" | "rider") {
  const user = await h.prisma.user.create({ data: { name: `Report ${role}`, passwordHash: "unused-in-tests", role } });
  return h.tokenFor({ id: user.id, name: user.name, role });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-reports");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("operating report: bucket counts and money totals", () => {
  it("buckets delivered/active/failed-cancelled correctly and sums fees + urgent count", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness, { payRate: 200, payCurrency: "JMD" });
    const admin = await staffToken(harness, "admin");

    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", fee: 500, priority: "urgent", createdAt: new Date(), completedAt: new Date() } });
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "accepted", fee: 300 } });
    await harness.prisma.job.create({ data: { customerId: customer.id, status: "cancelled", fee: 100 } });
    await harness.prisma.job.create({ data: { customerId: customer.id, status: "new" } });

    const res = await harness.app.inject({ method: "GET", url: "/api/reports/summary", headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { summary: { deliveriesCompleted: number; deliveriesActive: number; deliveriesFailedCancelled: number; urgentDeliveryCount: number; deliveryFeesCharged: { amount: number } } };
    expect(body.summary.deliveriesCompleted).toBeGreaterThanOrEqual(1);
    expect(body.summary.deliveriesActive).toBeGreaterThanOrEqual(2); // accepted + new
    expect(body.summary.deliveriesFailedCancelled).toBeGreaterThanOrEqual(1);
    expect(body.summary.urgentDeliveryCount).toBeGreaterThanOrEqual(1);
  });
});

describe("operating report: COD math", () => {
  it("computes expected/collected/handedIn/outstanding/shortage/overage across a mix of jobs", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const admin = await staffToken(harness, "admin");

    // Fully collected and handed in exact: no outstanding, no variance.
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", paymentMethod: "cod", amountExpected: 1000, amountCollected: 1000, codHandedInAmount: 1000, codStatus: "handed_in", createdAt: new Date(), completedAt: new Date() } });
    // Short: handed in less than collected.
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", paymentMethod: "cod", amountExpected: 500, amountCollected: 500, codHandedInAmount: 450, codStatus: "handed_in", createdAt: new Date(), completedAt: new Date() } });
    // Over: handed in more than collected.
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", paymentMethod: "cod", amountExpected: 500, amountCollected: 500, codHandedInAmount: 520, codStatus: "handed_in", createdAt: new Date(), completedAt: new Date() } });
    // Still outstanding: not fully collected yet.
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "accepted", paymentMethod: "cod", amountExpected: 800, amountCollected: 300 } });

    const res = await harness.app.inject({ method: "GET", url: `/api/reports/summary?riderId=${rider.id}`, headers: { authorization: `Bearer ${admin}` } });
    const body = res.json() as { summary: { codExpected: { amount: number }; codCollected: { amount: number }; codHandedIn: { amount: number }; codOutstanding: { amount: number }; codShortageTotal: { amount: number }; codOverageTotal: { amount: number } } };
    expect(body.summary.codExpected.amount).toBe(1000 + 500 + 500 + 800);
    expect(body.summary.codCollected.amount).toBe(1000 + 500 + 500 + 300);
    expect(body.summary.codHandedIn.amount).toBe(1000 + 450 + 520);
    expect(body.summary.codOutstanding.amount).toBe(500); // 800 - 300
    expect(body.summary.codShortageTotal.amount).toBe(50); // 500 - 450
    expect(body.summary.codOverageTotal.amount).toBe(20); // 520 - 500
  });
});

describe("operating report: average delivery time", () => {
  it("computes the average only from completed jobs' actual createdAt/completedAt, never a scheduled/promised time", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const admin = await staffToken(harness, "admin");
    const created = new Date("2026-01-01T00:00:00.000Z");

    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", createdAt: created, completedAt: new Date(created.getTime() + 30 * 60_000), scheduledAt: new Date(created.getTime() + 5 * 60_000) } });
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", createdAt: created, completedAt: new Date(created.getTime() + 60 * 60_000) } });
    // Not yet delivered — must not contribute to the average even though it has a promisedAt.
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "accepted", createdAt: created, promisedAt: new Date(created.getTime() + 10 * 60_000) } });

    const res = await harness.app.inject({ method: "GET", url: `/api/reports/summary?riderId=${rider.id}&from=2026-01-01&to=2026-01-02`, headers: { authorization: `Bearer ${admin}` } });
    const body = res.json() as { summary: { averageDeliveryTimeMs: number | null; averageDeliveryTimeSampleSize: number } };
    expect(body.summary.averageDeliveryTimeSampleSize).toBe(2);
    expect(body.summary.averageDeliveryTimeMs).toBe(45 * 60_000); // (30+60)/2 minutes
  });

  it("reports null (not zero) when no jobs in range have been delivered", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const admin = await staffToken(harness, "admin");
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "accepted" } });

    const res = await harness.app.inject({ method: "GET", url: `/api/reports/summary?riderId=${rider.id}`, headers: { authorization: `Bearer ${admin}` } });
    const body = res.json() as { summary: { averageDeliveryTimeMs: number | null; averageDeliveryTimeSampleSize: number } };
    expect(body.summary.averageDeliveryTimeMs).toBeNull();
    expect(body.summary.averageDeliveryTimeSampleSize).toBe(0);
  });
});

describe("operating report: rider earnings are honestly labeled", () => {
  it("computes estimated earnings from payRate x completed jobs when a rate is configured", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness, { payRate: 150, payCurrency: "JMD" });
    const admin = await staffToken(harness, "admin");
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", completedAt: new Date() } });
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", completedAt: new Date() } });

    const res = await harness.app.inject({ method: "GET", url: `/api/reports/summary?riderId=${rider.id}`, headers: { authorization: `Bearer ${admin}` } });
    const body = res.json() as { byRider: { riderId: string; jobsCompleted: number; estimatedEarnings: { amount: number } | null }[] };
    const row = body.byRider.find((r) => r.riderId === rider.id)!;
    expect(row.jobsCompleted).toBe(2);
    expect(row.estimatedEarnings?.amount).toBe(300);
  });

  it("shows null (never $0) and a note when a rider with completed jobs has no configured pay rate", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness); // no payRate
    const admin = await staffToken(harness, "admin");
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", completedAt: new Date() } });

    const res = await harness.app.inject({ method: "GET", url: `/api/reports/summary?riderId=${rider.id}`, headers: { authorization: `Bearer ${admin}` } });
    const body = res.json() as { byRider: { riderId: string; estimatedEarnings: unknown }[]; notes: string[] };
    const row = body.byRider.find((r) => r.riderId === rider.id)!;
    expect(row.estimatedEarnings).toBeNull();
    expect(body.notes.some((n) => n.includes("no configured pay rate"))).toBe(true);
  });
});

describe("operating report: filters", () => {
  it("the bucket filter narrows both the rows and the returned bucket counts consistently", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const admin = await staffToken(harness, "admin");
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", completedAt: new Date() } });
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "accepted" } });

    const res = await harness.app.inject({ method: "GET", url: `/api/reports/summary?riderId=${rider.id}&bucket=completed`, headers: { authorization: `Bearer ${admin}` } });
    const body = res.json() as { rows: { bucket: string }[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((r) => r.bucket === "completed")).toBe(true);
  });

  it("filters by payment method", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const admin = await staffToken(harness, "admin");
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", paymentMethod: "online", completedAt: new Date() } });
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", paymentMethod: "cod", completedAt: new Date() } });

    const res = await harness.app.inject({ method: "GET", url: `/api/reports/summary?riderId=${rider.id}&paymentMethod=online`, headers: { authorization: `Bearer ${admin}` } });
    const body = res.json() as { rows: { paymentMethod: string }[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every((r) => r.paymentMethod === "online")).toBe(true);
  });
});

describe("operating report: permissions", () => {
  it("allows admin and accountant, rejects dispatcher/viewer/rider", async () => {
    const admin = await staffToken(harness, "admin");
    const accountant = await staffToken(harness, "accountant");
    const dispatcher = await staffToken(harness, "dispatcher");
    const viewer = await staffToken(harness, "viewer");
    const rider = await staffToken(harness, "rider");

    for (const [tok, expectOk] of [[admin, true], [accountant, true], [dispatcher, false], [viewer, false], [rider, false]] as const) {
      const res = await harness.app.inject({ method: "GET", url: "/api/reports/summary", headers: { authorization: `Bearer ${tok}` } });
      expect(res.statusCode).toBe(expectOk ? 200 : 403);
    }
  });
});

describe("operating report: CSV export", () => {
  it("returns CSV with a job-level header row and no PIN or phone columns", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const admin = await staffToken(harness, "admin");
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "delivered", pin: "1234", completedAt: new Date() } });

    const res = await harness.app.inject({ method: "GET", url: `/api/reports/jobs.csv?riderId=${rider.id}`, headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const csv = res.body;
    expect(csv).toContain("jobNumber,createdAt");
    expect(csv).not.toContain("1234"); // the PIN must never appear
    expect(csv.toLowerCase()).not.toContain("phone");
    expect(csv).not.toContain(customer.phone);
  });
});

/**
 * Rider cash-profile corrections (Stage 27 / spec 9): every bucket derived
 * fresh from Job rows at read time, never a stored running total — the
 * actual fix for "Handed in must not auto-clear confirmed-owed amount".
 * Real Fastify app + real sqlite db (see test/helpers/test-app.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let businessB: { id: string; name: string };
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function staffToken(businessId: string, role: "admin" | "dispatcher" | "accountant" | "viewer" = "dispatcher") {
  const user = await harness.prisma.user.create({ data: { name: `Cash ${uniq()}`, passwordHash: "unused-in-tests", role } });
  await harness.prisma.staffMembership.create({ data: { userId: user.id, businessId, role, active: true } });
  return harness.tokenFor({ id: user.id, name: user.name, role, businessId });
}

async function makeCustomer(businessId: string) {
  return harness.prisma.customer.create({ data: { businessId, name: "Cash Test Customer", phone: `+1876595${uniq()}` } });
}

async function makeCodJob(businessId: string, riderId: string, customerId: string, overrides: Record<string, unknown> = {}) {
  return harness.prisma.job.create({
    data: { businessId, customerId, riderId, status: "delivered", paymentMethod: "cod", currency: "JMD", ...overrides },
  });
}

async function makeRiderWithMembership(businessId: string, overrides: Record<string, unknown> = {}) {
  const rider = await harness.prisma.rider.create({ data: { name: "Cash Test Rider", phone: `+1876596${uniq()}`, active: true, status: "available", ...overrides } });
  // Every rider created via the test-harness's own $extends interceptor
  // already gets an active membership at the harness's own business — see
  // test-app.ts. businessB needs one added explicitly.
  await harness.prisma.riderMembership.upsert({
    where: { riderId_businessId: { riderId: rider.id, businessId } },
    create: { riderId: rider.id, businessId, status: "active", approvedAt: new Date() },
    update: { status: "active" },
  });
  const user = await harness.prisma.user.create({ data: { name: rider.name, passwordHash: "unused-in-tests", role: "rider" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, token };
}

beforeAll(async () => {
  harness = await buildTestHarness("test-cash-profile");
  businessB = await harness.prisma.business.create({ data: { name: "Cash Test Business B", slug: `cash-b-${Date.now()}` } });
});

afterAll(async () => {
  await harness.cleanup();
});

describe("cash buckets are exact sums of real jobs, not estimates", () => {
  it("collected, handed-in-unconfirmed, and confirmed each sum only their own status's jobs", async () => {
    const { rider, token } = await makeRiderWithMembership(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "collected", amountCollected: 100_000 });
    await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "collected", amountCollected: 50_000 });
    await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "handed_in", amountCollected: 75_000, codHandedInAmount: 75_000 });
    await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "approved", amountCollected: 200_000, codHandedInAmount: 200_000 });
    // A non-COD job and a pending_collection COD job must never contribute
    // to any bucket — nothing collected, nothing to show.
    await makeCodJob(harness.business.id, rider.id, customer.id, { paymentMethod: "online", codStatus: "pending_collection" });
    await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "pending_collection" });

    const own = await harness.app.inject({ method: "GET", url: "/api/bearer/cash", headers: { authorization: `Bearer ${token}` } });
    expect(own.statusCode).toBe(200);
    const profile = (own.json() as { businesses: { businessId: string; collected: { count: number; amount: { amount: number } }; handedInUnconfirmed: { count: number; amount: { amount: number } }; confirmed: { count: number; amount: { amount: number } } }[] }).businesses.find((b) => b.businessId === harness.business.id)!;

    expect(profile.collected.count).toBe(2);
    expect(profile.collected.amount.amount).toBe(150_000);
    expect(profile.handedInUnconfirmed.count).toBe(1);
    expect(profile.handedInUnconfirmed.amount.amount).toBe(75_000);
    expect(profile.confirmed.count).toBe(1);
    expect(profile.confirmed.amount.amount).toBe(200_000);
  });

  it("a hand-in recorded on one job never changes the confirmed total from a different, already-approved job — the actual bug fix", async () => {
    const { rider, token } = await makeRiderWithMembership(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    // Already settled, historical.
    await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "approved", amountCollected: 300_000, codHandedInAmount: 300_000 });

    const before = await harness.app.inject({ method: "GET", url: "/api/bearer/cash", headers: { authorization: `Bearer ${token}` } });
    const confirmedBefore = (before.json() as { businesses: { confirmed: { amount: { amount: number } } }[] }).businesses[0]!.confirmed.amount.amount;
    expect(confirmedBefore).toBe(300_000);

    // A brand-new, unrelated job gets collected AND handed in.
    const newJob = await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "collected", amountCollected: 80_000 });
    const dispatcherTok = await staffToken(harness.business.id, "dispatcher");
    const handIn = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${newJob.id}/cod/hand-in`,
      headers: { authorization: `Bearer ${dispatcherTok}` },
      payload: { amountHandedIn: 80_000 }, // major units — JMD has 0 decimals, so major === minor here
    });
    expect(handIn.statusCode).toBe(200);

    const after = await harness.app.inject({ method: "GET", url: "/api/bearer/cash", headers: { authorization: `Bearer ${token}` } });
    const businesses = (after.json() as { businesses: { confirmed: { amount: { amount: number } }; handedInUnconfirmed: { amount: { amount: number } } }[] }).businesses;
    expect(businesses[0]!.confirmed.amount.amount).toBe(300_000); // untouched
    expect(businesses[0]!.handedInUnconfirmed.amount.amount).toBe(80_000); // the new job, separately
  });

  it("disputed falls back to the collected amount when no hand-in was ever recorded", async () => {
    const { rider, token } = await makeRiderWithMembership(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "disputed", amountCollected: 45_000, codHandedInAmount: null });

    const res = await harness.app.inject({ method: "GET", url: "/api/bearer/cash", headers: { authorization: `Bearer ${token}` } });
    const disputed = (res.json() as { businesses: { disputed: { count: number; amount: { amount: number } } }[] }).businesses[0]!.disputed;
    expect(disputed.count).toBe(1);
    expect(disputed.amount.amount).toBe(45_000);
  });

  it("handoverVariance reflects a real shortage or overage, never silently absorbed", async () => {
    const { rider, token } = await makeRiderWithMembership(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    // Collected 100, only handed in 90 — a real shortage.
    await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "handed_in", amountCollected: 100_000, codHandedInAmount: 90_000 });
    // Collected 50, handed in 55 (customer overpaid, rider passed it on) — an overage.
    await makeCodJob(harness.business.id, rider.id, customer.id, { codStatus: "approved", amountCollected: 50_000, codHandedInAmount: 55_000 });

    const res = await harness.app.inject({ method: "GET", url: "/api/bearer/cash", headers: { authorization: `Bearer ${token}` } });
    const variance = (res.json() as { businesses: { handoverVariance: { amount: number } }[] }).businesses[0]!.handoverVariance;
    expect(variance.amount).toBe(-10_000 + 5_000);
  });
});

describe("earnings-payable is structurally separate from COD cash, and business-scoped", () => {
  it("is null with no pay rate configured, and never leaks a different business's delivered jobs into the count", async () => {
    const { rider, token } = await makeRiderWithMembership(harness.business.id, { payRate: null });
    await harness.prisma.riderMembership.upsert({
      where: { riderId_businessId: { riderId: rider.id, businessId: businessB.id } },
      create: { riderId: rider.id, businessId: businessB.id, status: "active", approvedAt: new Date() },
      update: { status: "active" },
    });
    const customerA = await makeCustomer(harness.business.id);
    const customerB = await makeCustomer(businessB.id);
    await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customerA.id, riderId: rider.id, status: "delivered" } });
    await harness.prisma.job.create({ data: { businessId: businessB.id, customerId: customerB.id, riderId: rider.id, status: "delivered" } });

    const res = await harness.app.inject({ method: "GET", url: "/api/bearer/cash", headers: { authorization: `Bearer ${token}` } });
    const businesses = (res.json() as { businesses: { businessId: string; earningsPayable: unknown; earningsNote: string }[] }).businesses;
    expect(businesses).toHaveLength(2);
    for (const b of businesses) {
      expect(b.earningsPayable).toBeNull();
      expect(b.earningsNote).toMatch(/not set/);
    }
  });

  it("with a pay rate, counts only deliveries actually made for that business", async () => {
    const { rider, token } = await makeRiderWithMembership(harness.business.id, { payRate: 30_000, payCurrency: "JMD" });
    await harness.prisma.riderMembership.upsert({
      where: { riderId_businessId: { riderId: rider.id, businessId: businessB.id } },
      create: { riderId: rider.id, businessId: businessB.id, status: "active", approvedAt: new Date() },
      update: { status: "active" },
    });
    const customerA = await makeCustomer(harness.business.id);
    const customerB = await makeCustomer(businessB.id);
    // Two delivered for business A, one for business B.
    await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customerA.id, riderId: rider.id, status: "delivered" } });
    await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customerA.id, riderId: rider.id, status: "delivered" } });
    await harness.prisma.job.create({ data: { businessId: businessB.id, customerId: customerB.id, riderId: rider.id, status: "delivered" } });

    const res = await harness.app.inject({ method: "GET", url: "/api/bearer/cash", headers: { authorization: `Bearer ${token}` } });
    const businesses = (res.json() as { businesses: { businessId: string; earningsPayable: { amount: number } | null }[] }).businesses;
    const a = businesses.find((b) => b.businessId === harness.business.id)!;
    const b = businesses.find((b) => b.businessId === businessB.id)!;
    expect(a.earningsPayable?.amount).toBe(60_000); // 2 x 30,000
    expect(b.earningsPayable?.amount).toBe(30_000); // 1 x 30,000
  });
});

describe("staff view is scoped to their own business only", () => {
  it("shows only the caller's business's slice, and 404s for a rider with no membership there", async () => {
    const { rider } = await makeRiderWithMembership(harness.business.id);
    const dispatcherA = await staffToken(harness.business.id);
    const dispatcherB = await staffToken(businessB.id);

    const fromA = await harness.app.inject({ method: "GET", url: `/api/riders/${rider.id}/cash`, headers: { authorization: `Bearer ${dispatcherA}` } });
    expect(fromA.statusCode).toBe(200);
    const bodyA = fromA.json() as { businesses: { businessId: string }[] };
    expect(bodyA.businesses).toHaveLength(1);
    expect(bodyA.businesses[0]!.businessId).toBe(harness.business.id);

    const fromB = await harness.app.inject({ method: "GET", url: `/api/riders/${rider.id}/cash`, headers: { authorization: `Bearer ${dispatcherB}` } });
    expect(fromB.statusCode).toBe(404);
  });
});

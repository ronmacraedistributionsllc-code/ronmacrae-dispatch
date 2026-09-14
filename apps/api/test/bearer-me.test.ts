/**
 * Stage D (spec: "show the courier their active business memberships
 * clearly", "prevent cross-merchant access at both UI and API level,
 * including manual URL/API attempts"). Real Fastify app + real sqlite db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeRider(h: TestHarness, overrides: Record<string, unknown> = {}) {
  const rider = await h.prisma.rider.create({ data: { name: `Bearer Me Rider ${uniq()}`, phone: `+1876573${uniq().slice(-4)}`, active: true, status: "available", ...overrides } });
  const user = await h.prisma.user.create({ data: { name: rider.name, passwordHash: "unused-in-tests", role: "rider" } });
  const token = await h.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, token };
}

async function adminToken(h: TestHarness, businessId?: string) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: businessId ?? h.business.id });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-bearer-me");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("GET /api/bearer/me", () => {
  it("lists this courier's own active business memberships, merchant roster attachments, and platform-admin eligibility attachment — nothing more, nothing less", async () => {
    const { rider, token } = await makeRider(harness);
    // A second business this rider is NOT a member of — must never appear.
    const otherBusiness = await harness.prisma.business.create({ data: { name: `Unrelated Co ${uniq()}`, slug: `unrelated-${uniq()}` } });
    await harness.prisma.riderMembership.create({ data: { riderId: rider.id, businessId: otherBusiness.id, status: "pending" } }); // pending, not active — must not show

    const merchant = await harness.prisma.merchant.create({ data: { businessId: harness.business.id, name: `Roster Store ${uniq()}`, slug: `roster-${uniq()}` } });
    await harness.prisma.merchantRider.create({ data: { merchantId: merchant.id, riderId: rider.id, status: "active", approvedAt: new Date() } });
    // A second merchant this rider was REMOVED from — must not show.
    const removedMerchant = await harness.prisma.merchant.create({ data: { businessId: harness.business.id, name: `Former Store ${uniq()}`, slug: `former-${uniq()}` } });
    await harness.prisma.merchantRider.create({ data: { merchantId: removedMerchant.id, riderId: rider.id, status: "removed" } });

    const res = await harness.app.inject({ method: "GET", url: "/api/bearer/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rider: { id: string }; businesses: { businessId: string; businessName: string }[]; merchants: { merchantId: string; merchantName: string }[]; attachment: { type: string } };
    expect(body.rider.id).toBe(rider.id);
    expect(body.businesses.map((b) => b.businessId)).toEqual([harness.business.id]);
    expect(body.businesses.some((b) => b.businessId === otherBusiness.id)).toBe(false);
    expect(body.merchants.map((m) => m.merchantId)).toEqual([merchant.id]);
    expect(body.merchants.some((m) => m.merchantId === removedMerchant.id)).toBe(false);
    expect(body.attachment.type).toBe("freelance");
  });

  it("is rider-only — staff cannot call the bearer-scoped endpoint", async () => {
    const admin = await adminToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/bearer/me", headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(403);
  });
});

describe("cross-courier job access — manual API attempts", () => {
  it("a courier cannot accept another courier's job by guessing its id", async () => {
    const { rider: ownerRider } = await makeRider(harness);
    const { token: strangerToken } = await makeRider(harness);
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: `Cross-Access Customer ${uniq()}`, phone: `+1876574${uniq().slice(-4)}` } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: ownerRider.id, status: "assigned" } });

    const accept = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/accept`, headers: { authorization: `Bearer ${strangerToken}` } });
    expect(accept.statusCode).toBe(403);
  });

  it("a courier cannot transition or set the stage of another courier's already-accepted job by guessing its id", async () => {
    const { rider: ownerRider } = await makeRider(harness);
    const { token: strangerToken } = await makeRider(harness);
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: `Cross-Access Customer ${uniq()}`, phone: `+1876574${uniq().slice(-4)}` } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: ownerRider.id, status: "accepted" } });

    const transition = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/transition`, headers: { authorization: `Bearer ${strangerToken}` }, payload: { to: "picked_up" } });
    expect(transition.statusCode).toBe(403);

    const stage = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/stage`, headers: { authorization: `Bearer ${strangerToken}` }, payload: { stage: "at_pickup" } });
    expect(stage.statusCode).toBe(403);
  });

  it("a courier's own job list never includes another courier's job", async () => {
    const { rider: riderA, token: tokenA } = await makeRider(harness);
    const { rider: riderB } = await makeRider(harness);
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: `List Isolation Customer ${uniq()}`, phone: `+1876575${uniq().slice(-4)}` } });
    const jobA = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: riderA.id, status: "assigned" } });
    const jobB = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: riderB.id, status: "assigned" } });

    const res = await harness.app.inject({ method: "GET", url: "/api/bearer/jobs", headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.statusCode).toBe(200);
    const { jobs } = res.json() as { jobs: { id: string }[] };
    expect(jobs.some((j) => j.id === jobA.id)).toBe(true);
    expect(jobs.some((j) => j.id === jobB.id)).toBe(false);
  });
});

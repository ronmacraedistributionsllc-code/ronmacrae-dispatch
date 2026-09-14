/**
 * Rider ratings after a completed delivery (spec: "Authorized customer
 * and merchant may rate after a completed delivery... Prevent duplicate
 * ratings, self-ratings, abusive content, and cross-business leaks").
 * Customer side is gated by the same tracking token the customer already
 * uses to track the order (tracking.ts); merchant side by the merchant's
 * own portal session, scoped to its own order (merchant-portal.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: h.business.id });
}

async function ownerToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Owner ${uniq()}`, passwordHash: "unused-in-tests", role: "admin", platformRole: "owner" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", platformRole: "owner" });
}

async function makeCustomer(h: TestHarness) {
  return h.prisma.customer.create({ data: { businessId: h.business.id, name: "Rating Test Customer", phone: `+1876582${uniq()}` } });
}

async function makeRider(h: TestHarness) {
  return h.prisma.rider.create({ data: { name: "Rating Test Rider", phone: `+1876583${uniq()}`, active: true, status: "available" } });
}

async function trackingLink(h: TestHarness, jobId: string) {
  return h.prisma.trackingLink.create({ data: { jobId, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000) } });
}

async function makeMerchant(h: TestHarness, auth: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/merchants",
    headers: { authorization: `Bearer ${auth}` },
    payload: { name: `VBR Basics ${uniq()}`, notificationEmails: "owner@vbr.example" },
  });
  return (res.json() as { merchant: { id: string } }).merchant;
}

async function merchantPortalToken(h: TestHarness, admin: string, merchantId: string): Promise<string> {
  const email = `owner-${uniq()}@vbr.example`;
  await h.app.inject({ method: "POST", url: `/api/merchants/${merchantId}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email, password: "merchantpass1" } });
  const login = await h.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email, password: "merchantpass1" } });
  return (login.json() as { token: string }).token;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-ratings");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("customer rating (tracking-token-gated)", () => {
  it("rates a delivered order, cannot rate it twice, and cannot rate an undelivered one", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const notDelivered = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "in_transit" } });
    const notDeliveredLink = await trackingLink(harness, notDelivered.id);

    const tooSoon = await harness.app.inject({ method: "POST", url: `/api/tracking/${notDeliveredLink.token}/rate`, payload: { score: 5 } });
    expect(tooSoon.statusCode).toBe(400);

    const delivered = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered" } });
    const link = await trackingLink(harness, delivered.id);

    const rate = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/rate`, payload: { score: 5, comment: "Great service" } });
    expect(rate.statusCode).toBe(200);

    const duplicate = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/rate`, payload: { score: 1 } });
    expect(duplicate.statusCode).toBe(409);

    const row = await harness.prisma.rating.findUniqueOrThrow({ where: { jobId_raterType_target: { jobId: delivered.id, raterType: "customer", target: "rider" } } });
    expect(row.score).toBe(5);
    expect(row.riderId).toBe(rider.id);
  });

  it("rejects an out-of-range score", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered" } });
    const link = await trackingLink(harness, job.id);
    const res = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/rate`, payload: { score: 6 } });
    expect(res.statusCode).toBe(400);
  });
});

describe("customer rates merchant (tracking-token-gated)", () => {
  it("rates the merchant separately from the courier, and cannot double-rate either", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, merchantId: merchant.id, status: "delivered" } });
    const link = await trackingLink(harness, job.id);

    // Both ratings save separately.
    const rateCourier = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/rate`, payload: { score: 5 } });
    expect(rateCourier.statusCode).toBe(200);
    const rateMerchant = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/rate-merchant`, payload: { score: 4, comment: "Friendly store" } });
    expect(rateMerchant.statusCode).toBe(200);

    // Two distinct rows: one for the courier, one for the merchant.
    const courierRow = await harness.prisma.rating.findUniqueOrThrow({ where: { jobId_raterType_target: { jobId: job.id, raterType: "customer", target: "rider" } } });
    expect(courierRow.score).toBe(5);
    expect(courierRow.riderId).toBe(rider.id);
    const merchantRow = await harness.prisma.rating.findUniqueOrThrow({ where: { jobId_raterType_target: { jobId: job.id, raterType: "customer", target: "merchant" } } });
    expect(merchantRow.score).toBe(4);
    expect(merchantRow.merchantId).toBe(merchant.id);

    // Neither can be rated twice.
    const dupCourier = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/rate`, payload: { score: 1 } });
    expect(dupCourier.statusCode).toBe(409);
    const dupMerchant = await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/rate-merchant`, payload: { score: 1 } });
    expect(dupMerchant.statusCode).toBe(409);
  });

  it("cannot rate the merchant before delivery, or when the order has no merchant", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);

    const inTransit = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, merchantId: merchant.id, status: "in_transit" } });
    const tooSoonLink = await trackingLink(harness, inTransit.id);
    const tooSoon = await harness.app.inject({ method: "POST", url: `/api/tracking/${tooSoonLink.token}/rate-merchant`, payload: { score: 3 } });
    expect(tooSoon.statusCode).toBe(400);

    // No merchant on the job -> merchant rating refused.
    const noMerchant = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered" } });
    const noMerchantLink = await trackingLink(harness, noMerchant.id);
    const noMerchantRate = await harness.app.inject({ method: "POST", url: `/api/tracking/${noMerchantLink.token}/rate-merchant`, payload: { score: 3 } });
    expect(noMerchantRate.statusCode).toBe(400);
  });
});

describe("merchant rating (merchant-portal-gated)", () => {
  it("rates its own delivered order, but never another merchant's", async () => {
    const admin = await adminToken(harness);
    const merchantA = await makeMerchant(harness, admin);
    const merchantB = await makeMerchant(harness, admin);
    const tokenA = await merchantPortalToken(harness, admin, merchantA.id);
    const tokenB = await merchantPortalToken(harness, admin, merchantB.id);

    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, merchantId: merchantA.id, status: "delivered" } });

    const crossAttempt = await harness.app.inject({ method: "POST", url: `/api/merchant-portal/orders/${job.id}/rate`, headers: { authorization: `Bearer ${tokenB}` }, payload: { score: 1 } });
    expect(crossAttempt.statusCode).toBe(404);

    const rate = await harness.app.inject({ method: "POST", url: `/api/merchant-portal/orders/${job.id}/rate`, headers: { authorization: `Bearer ${tokenA}` }, payload: { score: 4 } });
    expect(rate.statusCode).toBe(200);

    const again = await harness.app.inject({ method: "POST", url: `/api/merchant-portal/orders/${job.id}/rate`, headers: { authorization: `Bearer ${tokenA}` }, payload: { score: 2 } });
    expect(again.statusCode).toBe(409);
  });
});

describe("platform-admin: ratings visible on rider detail, and moderation", () => {
  it("aggregates real ratings on the rider detail view, and hiding one excludes it from the average", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const owner = await ownerToken(harness);

    const job1 = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered" } });
    const link1 = await trackingLink(harness, job1.id);
    await harness.app.inject({ method: "POST", url: `/api/tracking/${link1.token}/rate`, payload: { score: 5 } });

    const job2 = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered" } });
    const link2 = await trackingLink(harness, job2.id);
    await harness.app.inject({ method: "POST", url: `/api/tracking/${link2.token}/rate`, payload: { score: 1, comment: "abusive junk" } });

    const before = await harness.app.inject({ method: "GET", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` } });
    const beforeBody = before.json() as { ratings: { average: number; count: number; recent: { id: string; score: number }[] } };
    expect(beforeBody.ratings.count).toBe(2);
    expect(beforeBody.ratings.average).toBe(3);

    const badRating = beforeBody.ratings.recent.find((r) => r.score === 1)!;
    const hide = await harness.app.inject({ method: "PATCH", url: `/api/platform/ratings/${badRating.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { hidden: true } });
    expect(hide.statusCode).toBe(200);

    const after = await harness.app.inject({ method: "GET", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` } });
    const afterBody = after.json() as { ratings: { average: number; count: number; recent: unknown[] } };
    expect(afterBody.ratings.count).toBe(1);
    expect(afterBody.ratings.average).toBe(5);
  });

  it("an ordinary staff member cannot moderate ratings", async () => {
    const admin = await adminToken(harness);
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered" } });
    const link = await trackingLink(harness, job.id);
    await harness.app.inject({ method: "POST", url: `/api/tracking/${link.token}/rate`, payload: { score: 3 } });
    const rating = await harness.prisma.rating.findUniqueOrThrow({ where: { jobId_raterType_target: { jobId: job.id, raterType: "customer", target: "rider" } } });

    const res = await harness.app.inject({ method: "PATCH", url: `/api/platform/ratings/${rating.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { hidden: true } });
    expect(res.statusCode).toBe(403);
  });
});

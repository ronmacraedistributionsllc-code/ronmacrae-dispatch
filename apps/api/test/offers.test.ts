/**
 * Integration tests for the job-offer flow: real Fastify app + real sqlite db
 * (see test/helpers/test-app.ts), so the concurrency assertions exercise actual
 * Prisma transactions racing against each other, not mocked logic.
 *
 * Covers the checkpoint's remaining items: atomic accept under concurrency
 * (rider vs rider, and rider-accept vs dispatcher-assign), eligibility
 * (capacity) on both broadcast and rebroadcast, expiration, withdrawal, and
 * authorization (cross-rider accept, non-staff broadcast, unauthenticated).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeCustomer(h: TestHarness, overrides: Record<string, unknown> = {}) {
  return h.prisma.customer.create({ data: { businessId: h.business.id,  name: "Test Customer", phone: `+1876555${uniq()}`, ...overrides } });
}

async function makeRider(h: TestHarness, overrides: Record<string, unknown> = {}) {
  return h.prisma.rider.create({
    data: { name: "Test Rider", phone: `+1876556${uniq()}`, active: true, status: "available", dailyCapacity: 1, ...overrides },
  });
}

async function makeJob(h: TestHarness, customerId: string, overrides: Record<string, unknown> = {}) {
  return h.prisma.job.create({ data: { businessId: h.business.id,  customerId, status: "new", ...overrides } });
}

async function dispatcherToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: "Dee Dispatcher", passwordHash: "unused-in-tests", role: "dispatcher" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "dispatcher" });
}

async function riderToken(h: TestHarness, riderId: string) {
  const user = await h.prisma.user.create({ data: { name: "Test Rider", passwordHash: "unused-in-tests", role: "rider" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "rider", riderId });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-offers");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("offer broadcast + accept — concurrency", () => {
  it("only one of two riders racing the same offer set wins the job", async () => {
    const customer = await makeCustomer(harness);
    const dispatcher = await dispatcherToken(harness);
    const job = await makeJob(harness, customer.id);
    const riderA = await makeRider(harness);
    const riderB = await makeRider(harness);

    const broadcastRes = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [riderA.id, riderB.id] },
    });
    expect(broadcastRes.statusCode).toBe(200);
    const { offers } = broadcastRes.json() as { offers: { id: string; jobId: string }[] };
    expect(offers).toHaveLength(2);

    const offersInDb = await harness.prisma.jobOffer.findMany({ where: { jobId: job.id } });
    const offerFor = (riderId: string) => offersInDb.find((o) => o.riderId === riderId)!;
    const tokenA = await riderToken(harness, riderA.id);
    const tokenB = await riderToken(harness, riderB.id);

    // Fire both accepts in parallel — this is the actual race, not a simulated one.
    const [resA, resB] = await Promise.all([
      harness.app.inject({
        method: "POST",
        url: `/api/bearer/offers/${offerFor(riderA.id).id}/accept`,
        headers: { authorization: `Bearer ${tokenA}` },
      }),
      harness.app.inject({
        method: "POST",
        url: `/api/bearer/offers/${offerFor(riderB.id).id}/accept`,
        headers: { authorization: `Bearer ${tokenB}` },
      }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const winnerRiderId = resA.statusCode === 200 ? riderA.id : riderB.id;
    const loserRiderId = winnerRiderId === riderA.id ? riderB.id : riderA.id;

    const finalJob = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    // Accepting an offer is the rider's one and only accept step (spec item
    // 1) — it lands straight on `accepted`, not the intermediate `assigned`
    // a dispatcher's direct assignment still uses.
    expect(finalJob.status).toBe("accepted");
    expect(finalJob.riderId).toBe(winnerRiderId);

    const winnerOffer = await harness.prisma.jobOffer.findUniqueOrThrow({ where: { id: offerFor(winnerRiderId).id } });
    const loserOffer = await harness.prisma.jobOffer.findUniqueOrThrow({ where: { id: offerFor(loserRiderId).id } });
    expect(winnerOffer.status).toBe("accepted");
    expect(loserOffer.status).toBe("withdrawn");

    // Exactly one RiderAssignment row was created for this job — no double-assignment.
    const assignments = await harness.prisma.riderAssignment.findMany({ where: { jobId: job.id } });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.riderId).toBe(winnerRiderId);
  });

  it("a rider's offer-accept and a dispatcher's manual assignment racing the same job never both win", async () => {
    const customer = await makeCustomer(harness);
    const dispatcher = await dispatcherToken(harness);
    const job = await makeJob(harness, customer.id);
    const riderA = await makeRider(harness); // will accept an offer
    const riderB = await makeRider(harness); // dispatcher assigns directly

    const broadcastRes = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [riderA.id] },
    });
    const { offers } = broadcastRes.json() as { offers: { id: string }[] };
    const tokenA = await riderToken(harness, riderA.id);

    const [acceptRes, assignRes] = await Promise.all([
      harness.app.inject({
        method: "POST",
        url: `/api/bearer/offers/${offers[0]!.id}/accept`,
        headers: { authorization: `Bearer ${tokenA}` },
      }),
      harness.app.inject({
        method: "POST",
        url: `/api/jobs/${job.id}/assignments`,
        headers: { authorization: `Bearer ${dispatcher}` },
        payload: { riderId: riderB.id },
      }),
    ]);

    const statuses = [acceptRes.statusCode, assignRes.statusCode].sort();
    // Exactly one of the two conditional claims (both gated on `status: "new", riderId: null`) wins.
    expect(statuses).toEqual([200, 409]);

    const finalJob = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    // Whichever path won determines the status: the rider's own offer-accept
    // lands on `accepted` directly (their one accept step already happened),
    // a dispatcher's direct assignment still lands on `assigned` pending the
    // rider's separate accept.
    expect(finalJob.status).toBe(finalJob.riderId === riderA.id ? "accepted" : "assigned");
    expect([riderA.id, riderB.id]).toContain(finalJob.riderId);

    const assignments = await harness.prisma.riderAssignment.findMany({ where: { jobId: job.id } });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.riderId).toBe(finalJob.riderId);
  });
});

describe("offer eligibility (capacity)", () => {
  it("excludes a rider already at daily capacity from both broadcast and rebroadcast", async () => {
    const customer = await makeCustomer(harness);
    const busyRider = await makeRider(harness, { dailyCapacity: 1 });
    const freeRider = await makeRider(harness, { dailyCapacity: 1 });
    // Occupy busyRider's one slot with an unrelated active job.
    await makeJob(harness, customer.id, { riderId: busyRider.id, status: "assigned" });

    const job = await makeJob(harness, customer.id);
    const dispatcher = await dispatcherToken(harness);

    // JobOfferDto intentionally omits riderId (privacy-scoped response), so assert on
    // the underlying rows rather than the HTTP response body.
    const broadcastRes = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [busyRider.id, freeRider.id] },
    });
    expect(broadcastRes.statusCode).toBe(200);
    const afterBroadcast = await harness.prisma.jobOffer.findMany({ where: { jobId: job.id, status: "open" } });
    expect(afterBroadcast.map((o) => o.riderId)).toEqual([freeRider.id]);

    const rebroadcastRes = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/rebroadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [busyRider.id, freeRider.id] },
    });
    expect(rebroadcastRes.statusCode).toBe(200);
    const afterRebroadcast = await harness.prisma.jobOffer.findMany({ where: { jobId: job.id, status: "open" } });
    expect(afterRebroadcast.map((o) => o.riderId)).toEqual([freeRider.id]);
  });
});

describe("offer expiration", () => {
  it("an expired offer cannot be accepted and is swept to status=expired", async () => {
    const customer = await makeCustomer(harness);
    const job = await makeJob(harness, customer.id);
    const rider = await makeRider(harness);
    const offer = await harness.prisma.jobOffer.create({ data: { businessId: harness.business.id,  jobId: job.id, riderId: rider.id, expiresAt: new Date(Date.now() - 60_000) },
    });
    const token = await riderToken(harness, rider.id);

    const acceptRes = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/offers/${offer.id}/accept`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(acceptRes.statusCode).toBe(409);

    const row = await harness.prisma.jobOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(row.status).toBe("expired");

    const listRes = await harness.app.inject({
      method: "GET",
      url: "/api/bearer/offers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((listRes.json() as { offers: unknown[] }).offers).toHaveLength(0);
  });
});

describe("offer withdrawal", () => {
  it("a withdrawn offer cannot be accepted", async () => {
    const customer = await makeCustomer(harness);
    const job = await makeJob(harness, customer.id);
    const rider = await makeRider(harness);
    const dispatcher = await dispatcherToken(harness);

    const broadcastRes = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [rider.id] },
    });
    const { offers } = broadcastRes.json() as { offers: { id: string }[] };

    const withdrawRes = await harness.app.inject({
      method: "POST",
      url: `/api/offers/${offers[0]!.id}/withdraw`,
      headers: { authorization: `Bearer ${dispatcher}` },
    });
    expect(withdrawRes.statusCode).toBe(200);

    const token = await riderToken(harness, rider.id);
    const acceptRes = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/offers/${offers[0]!.id}/accept`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(acceptRes.statusCode).toBe(409);
  });
});

describe("offer authorization", () => {
  it("rejects an unauthenticated broadcast request", async () => {
    const customer = await makeCustomer(harness);
    const job = await makeJob(harness, customer.id);
    const res = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/offers/broadcast` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a broadcast request from a rider (non-staff) token", async () => {
    const customer = await makeCustomer(harness);
    const job = await makeJob(harness, customer.id);
    const rider = await makeRider(harness);
    const token = await riderToken(harness, rider.id);
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a rider cannot accept another rider's offer", async () => {
    const customer = await makeCustomer(harness);
    const job = await makeJob(harness, customer.id);
    const riderA = await makeRider(harness);
    const riderB = await makeRider(harness);
    const dispatcher = await dispatcherToken(harness);

    const broadcastRes = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [riderA.id] },
    });
    const { offers } = broadcastRes.json() as { offers: { id: string }[] };
    const tokenB = await riderToken(harness, riderB.id);

    const res = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/offers/${offers[0]!.id}/accept`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(409);

    // The offer is untouched — riderA can still accept it.
    const row = await harness.prisma.jobOffer.findUniqueOrThrow({ where: { id: offers[0]!.id } });
    expect(row.status).toBe("open");
  });
});

describe("a rider stays eligible for more offers after accepting one (multi-job capacity)", () => {
  it("keeps status 'available' through accept, and remains eligible for a fresh broadcast while under capacity", async () => {
    const customer = await makeCustomer(harness);
    const dispatcher = await dispatcherToken(harness);
    const rider = await makeRider(harness, { dailyCapacity: 2 });

    const jobA = await makeJob(harness, customer.id);
    const broadcastA = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${jobA.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [rider.id] },
    });
    const { offers: offersA } = broadcastA.json() as { offers: { id: string }[] };
    const riderTok = await riderToken(harness, rider.id);
    const acceptA = await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${offersA[0]!.id}/accept`, headers: { authorization: `Bearer ${riderTok}` } });
    expect(acceptA.statusCode).toBe(200);

    // The old bug: accepting a job used to flip the rider to "on_job", which
    // excluded them from `status: "available"` broadcast eligibility even though
    // they were still well under capacity (1/2). Confirm that no longer happens.
    const afterAccept = await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(afterAccept.status).toBe("available");

    const jobB = await makeJob(harness, customer.id);
    const broadcastB = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${jobB.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [rider.id] },
    });
    const { offers: offersB } = broadcastB.json() as { offers: { id: string; riderId: string }[] };
    expect(offersB).toHaveLength(1);
    expect(offersB[0]!.riderId).toBe(rider.id);

    // And a second accept succeeds too, bringing them to exactly capacity.
    const acceptB = await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${offersB[0]!.id}/accept`, headers: { authorization: `Bearer ${riderTok}` } });
    expect(acceptB.statusCode).toBe(200);

    const activeCount = await harness.prisma.job.count({ where: { riderId: rider.id, status: { in: ["assigned", "accepted", "picked_up", "in_transit", "delivering", "location_changed", "no_answer"] } } });
    expect(activeCount).toBe(2);

    // Now at capacity (2/2) — a third broadcast must exclude them.
    const jobC = await makeJob(harness, customer.id);
    const broadcastC = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${jobC.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [rider.id] },
    });
    const { offers: offersC } = broadcastC.json() as { offers: { id: string }[] };
    expect(offersC).toHaveLength(0);
  });

  it("rejects an accept that would push the rider over capacity, even when the offer itself is still open (race protection)", async () => {
    const customer = await makeCustomer(harness);
    const dispatcher = await dispatcherToken(harness);
    const rider = await makeRider(harness, { dailyCapacity: 1 });
    const riderTok = await riderToken(harness, rider.id);

    // Two separate broadcasts, each seeing the rider as under capacity (0/1) at
    // the time they were created — this can legitimately happen if the second
    // broadcast is issued before the rider acts on the first offer.
    const jobA = await makeJob(harness, customer.id);
    const jobB = await makeJob(harness, customer.id);
    const bA = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobA.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcher}` }, payload: { riderIds: [rider.id] } });
    const bB = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobB.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcher}` }, payload: { riderIds: [rider.id] } });
    const offerA = (bA.json() as { offers: { id: string }[] }).offers[0]!;
    const offerB = (bB.json() as { offers: { id: string }[] }).offers[0]!;

    const acceptA = await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${offerA.id}/accept`, headers: { authorization: `Bearer ${riderTok}` } });
    expect(acceptA.statusCode).toBe(200);

    // Accepting the second would put them at 2/1 — must be rejected, and the
    // rejection must not have left jobB half-claimed.
    const acceptB = await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${offerB.id}/accept`, headers: { authorization: `Bearer ${riderTok}` } });
    expect(acceptB.statusCode).toBe(409);

    const jobBRow = await harness.prisma.job.findUniqueOrThrow({ where: { id: jobB.id } });
    expect(jobBRow.status).toBe("new");
    expect(jobBRow.riderId).toBeNull();
  });
});

describe("rider status is rider-controlled, not job-lifecycle-controlled", () => {
  it("accepting an assignment and completing it never changes rider.status away from what the rider set", async () => {
    const customer = await makeCustomer(harness);
    const dispatcher = await dispatcherToken(harness);
    const rider = await makeRider(harness, { dailyCapacity: 3 });
    const riderTok = await riderToken(harness, rider.id);

    const job = await makeJob(harness, customer.id, { pin: "482913" });
    const assign = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/assignments`, headers: { authorization: `Bearer ${dispatcher}` }, payload: { riderId: rider.id } });
    expect(assign.statusCode).toBe(200);

    const accept = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/accept`, headers: { authorization: `Bearer ${riderTok}` } });
    expect(accept.statusCode).toBe(200);
    expect((await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).status).toBe("available");

    // Take the job all the way to a terminal status — status must still be untouched.
    for (const to of ["picked_up", "in_transit", "delivering"]) {
      const res = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/transition`, headers: { authorization: `Bearer ${riderTok}` }, payload: { to } });
      expect(res.statusCode).toBe(200);
    }
    const deliver = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/transition`, headers: { authorization: `Bearer ${riderTok}` }, payload: { to: "delivered", pin: "482913" } });
    expect(deliver.statusCode).toBe(200);
    expect((await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).status).toBe("available");
  });

  it("a rider can go 'unavailable' while still carrying an active job, but not fully 'offline'", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRider(harness, { dailyCapacity: 3 });
    const riderTok = await riderToken(harness, rider.id);
    const job = await makeJob(harness, customer.id, { riderId: rider.id, status: "assigned" });
    void job;

    const toUnavailable = await harness.app.inject({ method: "PATCH", url: `/api/riders/${rider.id}/status`, headers: { authorization: `Bearer ${riderTok}` }, payload: { status: "unavailable" } });
    expect(toUnavailable.statusCode).toBe(200);

    const toOffline = await harness.app.inject({ method: "PATCH", url: `/api/riders/${rider.id}/status`, headers: { authorization: `Bearer ${riderTok}` }, payload: { status: "offline" } });
    expect(toOffline.statusCode).toBe(409);
  });
});

// Stage 36 (Bearer/Logistics companies): a rider's attachment restricts
// which jobs eligibleRiders() (offers.ts) will ever offer them — see that
// function's own doc comment for the exact rule, including the
// platformStatus:"approved" override.
describe("eligibility respects rider attachment (Stage 36)", () => {
  it("a merchant-attached rider is only eligible for that merchant's own jobs", async () => {
    const customer = await makeCustomer(harness);
    const dispatcher = await dispatcherToken(harness);
    const merchant = await harness.prisma.merchant.create({ data: { businessId: harness.business.id, name: `M ${uniq()}`, slug: `m-${uniq()}` } });
    const otherMerchant = await harness.prisma.merchant.create({ data: { businessId: harness.business.id, name: `M2 ${uniq()}`, slug: `m2-${uniq()}` } });
    const rider = await makeRider(harness, { attachment: "merchant", attachedMerchantId: merchant.id });

    const merchantJob = await makeJob(harness, customer.id, { merchantId: merchant.id });
    const broadcastForOwnMerchant = await harness.app.inject({ method: "POST", url: `/api/jobs/${merchantJob.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcher}` }, payload: {} });
    expect(broadcastForOwnMerchant.statusCode).toBe(200);
    expect((broadcastForOwnMerchant.json() as { offers: { riderId: string }[] }).offers.map((o) => o.riderId)).toContain(rider.id);

    const otherMerchantJob = await makeJob(harness, customer.id, { merchantId: otherMerchant.id });
    const broadcastForOtherMerchant = await harness.app.inject({ method: "POST", url: `/api/jobs/${otherMerchantJob.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcher}` }, payload: {} });
    expect(broadcastForOtherMerchant.statusCode).toBe(200);
    expect((broadcastForOtherMerchant.json() as { offers: { riderId: string }[] }).offers.map((o) => o.riderId)).not.toContain(rider.id);

    const directJob = await makeJob(harness, customer.id, {});
    const broadcastForDirect = await harness.app.inject({ method: "POST", url: `/api/jobs/${directJob.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcher}` }, payload: {} });
    expect((broadcastForDirect.json() as { offers: { riderId: string }[] }).offers.map((o) => o.riderId)).not.toContain(rider.id);
  });

  it("a logistics-attached rider is only eligible for direct (no-merchant) jobs", async () => {
    const customer = await makeCustomer(harness);
    const dispatcher = await dispatcherToken(harness);
    const company = await harness.prisma.logisticsCompany.create({ data: { businessId: harness.business.id, name: `L ${uniq()}`, slug: `l-${uniq()}` } });
    const merchant = await harness.prisma.merchant.create({ data: { businessId: harness.business.id, name: `M3 ${uniq()}`, slug: `m3-${uniq()}` } });
    const rider = await makeRider(harness, { attachment: "logistics", attachedLogisticsCompanyId: company.id });

    const directJob = await makeJob(harness, customer.id, {});
    const broadcastDirect = await harness.app.inject({ method: "POST", url: `/api/jobs/${directJob.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcher}` }, payload: {} });
    expect((broadcastDirect.json() as { offers: { riderId: string }[] }).offers.map((o) => o.riderId)).toContain(rider.id);

    const merchantJob = await makeJob(harness, customer.id, { merchantId: merchant.id });
    const broadcastMerchant = await harness.app.inject({ method: "POST", url: `/api/jobs/${merchantJob.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcher}` }, payload: {} });
    expect((broadcastMerchant.json() as { offers: { riderId: string }[] }).offers.map((o) => o.riderId)).not.toContain(rider.id);
  });

  it("platformStatus:approved overrides any attachment restriction — eligible for everything", async () => {
    const customer = await makeCustomer(harness);
    const dispatcher = await dispatcherToken(harness);
    const merchant = await harness.prisma.merchant.create({ data: { businessId: harness.business.id, name: `M4 ${uniq()}`, slug: `m4-${uniq()}` } });
    const otherMerchant = await harness.prisma.merchant.create({ data: { businessId: harness.business.id, name: `M5 ${uniq()}`, slug: `m5-${uniq()}` } });
    const rider = await makeRider(harness, { attachment: "merchant", attachedMerchantId: merchant.id, platformStatus: "approved" });

    const otherMerchantJob = await makeJob(harness, customer.id, { merchantId: otherMerchant.id });
    const broadcast = await harness.app.inject({ method: "POST", url: `/api/jobs/${otherMerchantJob.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcher}` }, payload: {} });
    expect((broadcast.json() as { offers: { riderId: string }[] }).offers.map((o) => o.riderId)).toContain(rider.id);
  });

  it("freelance (the default) is unrestricted — every pre-existing rider's behavior is unchanged", async () => {
    const customer = await makeCustomer(harness);
    const dispatcher = await dispatcherToken(harness);
    const merchant = await harness.prisma.merchant.create({ data: { businessId: harness.business.id, name: `M6 ${uniq()}`, slug: `m6-${uniq()}` } });
    const rider = await makeRider(harness); // attachment defaults to "freelance"
    expect(rider.attachment).toBe("freelance");

    const merchantJob = await makeJob(harness, customer.id, { merchantId: merchant.id });
    const broadcast = await harness.app.inject({ method: "POST", url: `/api/jobs/${merchantJob.id}/offers/broadcast`, headers: { authorization: `Bearer ${dispatcher}` }, payload: {} });
    expect((broadcast.json() as { offers: { riderId: string }[] }).offers.map((o) => o.riderId)).toContain(rider.id);
  });
});

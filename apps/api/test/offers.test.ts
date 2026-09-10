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
  return h.prisma.customer.create({ data: { name: "Test Customer", phone: `+1876555${uniq()}`, ...overrides } });
}

async function makeRider(h: TestHarness, overrides: Record<string, unknown> = {}) {
  return h.prisma.rider.create({
    data: { name: "Test Rider", phone: `+1876556${uniq()}`, active: true, status: "available", dailyCapacity: 1, ...overrides },
  });
}

async function makeJob(h: TestHarness, customerId: string, overrides: Record<string, unknown> = {}) {
  return h.prisma.job.create({ data: { customerId, status: "new", ...overrides } });
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
    const job = await makeJob(harness, customer.id);
    const riderA = await makeRider(harness);
    const riderB = await makeRider(harness);
    const dispatcher = await dispatcherToken(harness);

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
    expect(finalJob.status).toBe("assigned");
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
    const job = await makeJob(harness, customer.id);
    const riderA = await makeRider(harness); // will accept an offer
    const riderB = await makeRider(harness); // dispatcher assigns directly
    const dispatcher = await dispatcherToken(harness);

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
    expect(finalJob.status).toBe("assigned");
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
    const offer = await harness.prisma.jobOffer.create({
      data: { jobId: job.id, riderId: rider.id, expiresAt: new Date(Date.now() - 60_000) },
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

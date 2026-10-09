/**
 * Optional `Idempotency-Key` handling on the rider mutations the offline
 * action queue replays (offer accept, job accept, job transition).
 *
 * Why this exists: without a key, retrying a request whose response was
 * lost to the network re-executes it — and these endpoints' guarded writes
 * answer a re-execution with a 409 ("already claimed", "already moved
 * on"), which the queue would surface as a failure even though the action
 * actually succeeded. With a key, the replay returns the stored success.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeRider() {
  const rider = await harness.prisma.rider.create({
    data: { name: "Idem Rider", phone: `+1876557${uniq()}`, active: true, status: "available", dailyCapacity: 5 },
  });
  const user = await harness.prisma.user.create({ data: { name: "Idem Rider", passwordHash: "unused", role: "rider" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, auth: { authorization: `Bearer ${token}` } };
}

async function makeJobFor(riderId: string, status: "new" | "accepted" = "new") {
  const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Idem Customer", phone: `+1876558${uniq()}` } });
  return harness.prisma.job.create({
    data: { businessId: harness.business.id, customerId: customer.id, status, riderId: status === "new" ? null : riderId, pin: "1234" },
  });
}

async function dispatcherToken() {
  const user = await harness.prisma.user.create({ data: { name: "Idem Dispatcher", passwordHash: "unused", role: "dispatcher" } });
  return harness.tokenFor({ id: user.id, name: user.name, role: "dispatcher" });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-idempotency");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("offer accept with Idempotency-Key", () => {
  it("replaying the same key returns the stored success without double effects", async () => {
    const { rider, auth } = await makeRider();
    const job = await makeJobFor(rider.id);
    const dispatcher = await dispatcherToken();
    const broadcast = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [rider.id] },
    });
    expect(broadcast.statusCode).toBe(200);
    const offerId = (broadcast.json() as { offers: { id: string }[] }).offers[0]!.id;
    const key = `idem-${uniq()}-accept`;

    const first = await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${offerId}/accept`, headers: { ...auth, "idempotency-key": key } });
    expect(first.statusCode).toBe(200);
    const second = await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${offerId}/accept`, headers: { ...auth, "idempotency-key": key } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const assignments = await harness.prisma.riderAssignment.findMany({ where: { jobId: job.id } });
    expect(assignments).toHaveLength(1);
    const events = await harness.prisma.jobEvent.findMany({ where: { jobId: job.id, to: "accepted" } });
    expect(events).toHaveLength(1);
  });

  it("without a key, retrying a consumed accept is a 409 (the failure the queue avoids)", async () => {
    const { rider, auth } = await makeRider();
    const job = await makeJobFor(rider.id);
    const dispatcher = await dispatcherToken();
    const broadcast = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [rider.id] },
    });
    const offerId = (broadcast.json() as { offers: { id: string }[] }).offers[0]!.id;
    expect(await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${offerId}/accept`, headers: auth })).toMatchObject({ statusCode: 200 });
    expect(await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${offerId}/accept`, headers: auth })).toMatchObject({ statusCode: 409 });
  });

  it("one rider's key never replays another rider's response", async () => {
    const a = await makeRider();
    const b = await makeRider();
    const job = await makeJobFor(a.rider.id);
    const dispatcher = await dispatcherToken();
    const broadcast = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/offers/broadcast`,
      headers: { authorization: `Bearer ${dispatcher}` },
      payload: { riderIds: [a.rider.id, b.rider.id] },
    });
    const offers = (broadcast.json() as { offers: { id: string; riderId?: string }[] }).offers;
    expect(offers).toHaveLength(2);
    const offerA = offers.find((o) => o.riderId === a.rider.id)!;
    const offerB = offers.find((o) => o.riderId === b.rider.id)!;
    const key = `idem-${uniq()}-shared`;
    const firstA = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/offers/${offerA.id}/accept`,
      headers: { ...a.auth, "idempotency-key": key },
    });
    expect(firstA.statusCode).toBe(200);
    // B reuses A's key string on their OWN offer: scoped per user, so this
    // executes fresh (and loses the race for the same job) rather than
    // replaying A's acceptance of A's job.
    const resB = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/offers/${offerB.id}/accept`,
      headers: { ...b.auth, "idempotency-key": key },
    });
    expect(resB.statusCode).toBe(409);
  });
});

describe("job transition with Idempotency-Key", () => {
  it("replaying a collect returns the stored success with a single event", async () => {
    const { rider, auth } = await makeRider();
    const job = await makeJobFor(rider.id, "accepted");
    const key = `idem-${uniq()}-collect`;
    const url = `/api/bearer/jobs/${job.id}/transition`;
    const payload = { to: "picked_up" };

    const first = await harness.app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": key }, payload });
    expect(first.statusCode).toBe(200);
    const second = await harness.app.inject({ method: "POST", url, headers: { ...auth, "idempotency-key": key }, payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const events = await harness.prisma.jobEvent.findMany({ where: { jobId: job.id, to: "picked_up" } });
    expect(events).toHaveLength(1);
  });

  it("a malformed key is ignored, not rejected", async () => {
    const { rider, auth } = await makeRider();
    const job = await makeJobFor(rider.id, "accepted");
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${job.id}/transition`,
      headers: { ...auth, "idempotency-key": "!! not a key !!" },
      payload: { to: "picked_up" },
    });
    expect(res.statusCode).toBe(200);
  });
});

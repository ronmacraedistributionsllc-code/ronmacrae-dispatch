/**
 * Auto-dispatch: new jobs are automatically offered to every eligible
 * courier (no manual broadcast), couriers see unclaimed work in a pending
 * list they can claim, and businesses choose their courier pool
 * (company / free_roam / both) in settings.
 *
 * Real Fastify app + real sqlite db (see test/helpers/test-app.ts). The
 * auto-broadcast itself fires `void` after job creation, so tests wait
 * for the offer rows rather than sleeping a fixed amount.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeRider(opts: { platformStatus?: "pending" | "approved" | "suspended"; status?: "available" | "offline"; noMemberships?: boolean } = {}) {
  const rider = await harness.prisma.rider.create({
    data: {
      name: "Auto Rider",
      phone: `+1876556${uniq()}`,
      active: true,
      status: opts.status ?? "available",
      dailyCapacity: 5,
      platformStatus: opts.platformStatus ?? "pending",
    },
  });
  if (opts.noMemberships) {
    await harness.prisma.riderMembership.deleteMany({ where: { riderId: rider.id } });
  }
  const user = await harness.prisma.user.create({ data: { name: "Auto Rider", passwordHash: "unused", role: "rider" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, auth: { authorization: `Bearer ${token}` } };
}

async function makeDispatcher() {
  const user = await harness.prisma.user.create({ data: { name: "Auto Dispatcher", passwordHash: "unused", role: "dispatcher" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "dispatcher" });
  return { authorization: `Bearer ${token}` };
}

async function makeCustomer() {
  return harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Auto Customer", phone: `+1876555${uniq()}` } });
}

async function createJob(auth: { authorization: string }, customerId: string) {
  const res = await harness.app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: auth,
    payload: { customerId, itemSummary: "Auto Item", fare: 1000, paymentMethod: "cod" },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { job: { id: string } }).job.id;
}

async function offersFor(jobId: string) {
  return harness.prisma.jobOffer.findMany({ where: { jobId } });
}

/** Offers for one job scoped to exactly these riders — tests share one
 *  business, so riders accumulate across tests and bare totals lie. */
async function offersForRiders(jobId: string, riderIds: string[]) {
  return harness.prisma.jobOffer.findMany({ where: { jobId, riderId: { in: riderIds } } });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-auto-dispatch");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("auto-broadcast on job creation", () => {
  it("offers a new job to every eligible company rider without any manual broadcast", async () => {
    const a = await makeRider();
    const b = await makeRider();
    const dispatcher = await makeDispatcher();
    const customer = await makeCustomer();
    const jobId = await createJob(dispatcher, customer.id);

    await vi.waitFor(async () => expect((await offersForRiders(jobId, [a.rider.id, b.rider.id])).length).toBe(2));
    const riderIds = (await offersForRiders(jobId, [a.rider.id, b.rider.id])).map((o) => o.riderId).sort();
    expect(riderIds).toEqual([a.rider.id, b.rider.id].sort());
    const audit = await harness.prisma.auditLog.findFirst({ where: { action: "offer.auto_broadcast", entityId: jobId } });
    expect(audit).not.toBeNull();
  });

  it("skips riders whose membership is still pending — the job waits in the pending list instead", async () => {
    const pending = await makeRider();
    await harness.prisma.riderMembership.updateMany({ where: { riderId: pending.rider.id }, data: { status: "pending" } });
    const dispatcher = await makeDispatcher();
    const customer = await makeCustomer();
    const jobId = await createJob(dispatcher, customer.id);

    // Give the void-fired broadcast a chance, then assert silence for
    // this rider (other tests' active members may still be offered).
    await new Promise((r) => setTimeout(r, 100));
    expect(await offersForRiders(jobId, [pending.rider.id])).toHaveLength(0);
    // And the waitlisted rider sees no pool at all (no active membership).
    const list = await harness.app.inject({ method: "GET", url: "/api/bearer/pending-jobs", headers: pending.auth });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("honors autoBroadcast=false — fully manual flow restored", async () => {
    await makeRider();
    const dispatcher = await makeDispatcher();
    await harness.prisma.business.update({ where: { id: harness.business.id }, data: { autoBroadcastOffers: false } });
    try {
      const customer = await makeCustomer();
      const jobId = await createJob(dispatcher, customer.id);
      await new Promise((r) => setTimeout(r, 100));
      expect(await offersFor(jobId)).toHaveLength(0);
    } finally {
      await harness.prisma.business.update({ where: { id: harness.business.id }, data: { autoBroadcastOffers: true } });
    }
  });
});

describe("courier pools", () => {
  it("pool=company (default) ignores marketplace-approved riders without a membership", async () => {
    const free = await makeRider({ platformStatus: "approved", noMemberships: true });
    const dispatcher = await makeDispatcher();
    const customer = await makeCustomer();
    const jobId = await createJob(dispatcher, customer.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(await offersForRiders(jobId, [free.rider.id])).toHaveLength(0);
    const list = await harness.app.inject({ method: "GET", url: "/api/bearer/pending-jobs", headers: free.auth });
    expect((list.json() as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("pool=both offers marketplace-approved free-roam riders, and accepting creates their membership", async () => {
    await harness.prisma.business.update({ where: { id: harness.business.id }, data: { courierPool: "both" } });
    try {
      const free = await makeRider({ platformStatus: "approved", noMemberships: true });
      const dispatcher = await makeDispatcher();
      const customer = await makeCustomer();
      const jobId = await createJob(dispatcher, customer.id);

      await vi.waitFor(async () => expect((await offersForRiders(jobId, [free.rider.id])).length).toBe(1));
      const offer = (await offersForRiders(jobId, [free.rider.id]))[0]!;
      expect(offer.riderId).toBe(free.rider.id);

      const accept = await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${offer.id}/accept`, headers: free.auth });
      expect(accept.statusCode).toBe(200);
      const membership = await harness.prisma.riderMembership.findUnique({
        where: { riderId_businessId: { riderId: free.rider.id, businessId: harness.business.id } },
      });
      expect(membership?.status).toBe("active");
    } finally {
      await harness.prisma.business.update({ where: { id: harness.business.id }, data: { courierPool: "company" } });
    }
  });
});

describe("broadcast idempotency + pending-list exclusion", () => {
  it("a manual broadcast after auto-broadcast never stacks a second open offer", async () => {
    const rider = await makeRider();
    const dispatcher = await makeDispatcher();
    const customer = await makeCustomer();
    const jobId = await createJob(dispatcher, customer.id);
    await vi.waitFor(async () => expect((await offersForRiders(jobId, [rider.rider.id])).length).toBe(1));

    const again = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobId}/offers/broadcast`, headers: dispatcher, payload: {} });
    expect(again.statusCode).toBe(200);
    expect((await offersForRiders(jobId, [rider.rider.id])).filter((o) => o.status === "open")).toHaveLength(1);
  });

  it("pending list excludes jobs the rider already holds an open offer for", async () => {
    const rider = await makeRider();
    const dispatcher = await makeDispatcher();
    const customer = await makeCustomer();
    const jobId = await createJob(dispatcher, customer.id);
    await vi.waitFor(async () => expect((await offersForRiders(jobId, [rider.rider.id])).length).toBe(1));

    const list = await harness.app.inject({ method: "GET", url: "/api/bearer/pending-jobs", headers: rider.auth });
    const ids = ((list.json() as { jobs: { id: string }[] }).jobs).map((j) => j.id);
    expect(ids).not.toContain(jobId);
  });
});

describe("pending-jobs list + claim", () => {
  it("lists unclaimed jobs with offered flags, scoped to the caller's businesses", async () => {
    const member = await makeRider();
    const dispatcher = await makeDispatcher();
    const customer = await makeCustomer();
    // Manual broadcast to nobody-eligible produces zero offers but the
    // auto path already covered member offers; here disable auto to get a
    // truly unoffered job.
    await harness.prisma.business.update({ where: { id: harness.business.id }, data: { autoBroadcastOffers: false } });
    try {
      const jobId = await createJob(dispatcher, customer.id);
      const list = await harness.app.inject({ method: "GET", url: "/api/bearer/pending-jobs", headers: member.auth });
      expect(list.statusCode).toBe(200);
      const jobs = (list.json() as { jobs: { id: string }[] }).jobs;
      expect(jobs.map((j) => j.id)).toContain(jobId);
    } finally {
      await harness.prisma.business.update({ where: { id: harness.business.id }, data: { autoBroadcastOffers: true } });
    }
  });

  it("a claim wins the job, withdraws other offers, and a second claim 409s", async () => {
    const claimer = await makeRider();
    const other = await makeRider();
    const dispatcher = await makeDispatcher();
    const customer = await makeCustomer();
    const jobId = await createJob(dispatcher, customer.id);
    await vi.waitFor(async () => expect((await offersForRiders(jobId, [claimer.rider.id, other.rider.id])).length).toBe(2));

    const claim = await harness.app.inject({ method: "POST", url: `/api/bearer/pending-jobs/${jobId}/claim`, headers: claimer.auth });
    expect(claim.statusCode).toBe(200);
    expect((await harness.prisma.job.findUniqueOrThrow({ where: { id: jobId } })).riderId).toBe(claimer.rider.id);
    // The loser's open offer is withdrawn, not left dangling.
    const loserOffers = await harness.prisma.jobOffer.findMany({ where: { jobId, riderId: other.rider.id } });
    expect(loserOffers.every((o) => o.status !== "open")).toBe(true);

    // The offer-accept path agrees the job is gone.
    const otherOffer = (await harness.prisma.jobOffer.findMany({ where: { jobId, riderId: other.rider.id } }))[0];
    if (otherOffer) {
      const late = await harness.app.inject({ method: "POST", url: `/api/bearer/offers/${otherOffer.id}/accept`, headers: other.auth });
      expect(late.statusCode).toBe(409);
    }
    const second = await harness.app.inject({ method: "POST", url: `/api/bearer/pending-jobs/${jobId}/claim`, headers: other.auth });
    expect(second.statusCode).toBe(409);
  });

  it("never leaks another business's unclaimed jobs", async () => {
    const outsider = await makeRider();
    const otherBusiness = await harness.prisma.business.create({ data: { name: "Other Biz", slug: `other-biz-${uniq()}` } });
    const otherCustomer = await harness.prisma.customer.create({ data: { businessId: otherBusiness.id, name: "Other", phone: `+1876555${uniq()}` } });
    await harness.prisma.job.create({ data: { businessId: otherBusiness.id, customerId: otherCustomer.id, status: "new" } });
    const list = await harness.app.inject({ method: "GET", url: "/api/bearer/pending-jobs", headers: outsider.auth });
    const jobs = (list.json() as { jobs: { id: string }[] }).jobs;
    // Only this harness's own business is visible to the outsider-member.
    for (const j of jobs) {
      const row = await harness.prisma.job.findUniqueOrThrow({ where: { id: j.id }, select: { businessId: true } });
      expect(row.businessId).toBe(harness.business.id);
    }
  });
});

describe("dispatch settings", () => {
  it("admin can change the pool, auto-broadcast, and expiry; readers see them", async () => {
    const admin = await harness.prisma.user.create({ data: { name: "Auto Admin", passwordHash: "unused", role: "admin" } });
    const token = await harness.tokenFor({ id: admin.id, name: admin.name, role: "admin" });
    const auth = { authorization: `Bearer ${token}` };
    const get = await harness.app.inject({ method: "GET", url: "/api/settings/business", headers: auth });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ settings: { autoBroadcastOffers: true, courierPool: "company", offerExpiryMinutes: 15 } });

    const put = await harness.app.inject({
      method: "PUT",
      url: "/api/settings/business",
      headers: auth,
      payload: {
        businessName: "Test Business",
        autoBroadcastOffers: false,
        courierPool: "both",
        offerExpiryMinutes: 30,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ settings: { autoBroadcastOffers: false, courierPool: "both", offerExpiryMinutes: 30 } });

    await harness.prisma.business.update({ where: { id: harness.business.id }, data: { autoBroadcastOffers: true, courierPool: "company", offerExpiryMinutes: 15 } });
  });
});

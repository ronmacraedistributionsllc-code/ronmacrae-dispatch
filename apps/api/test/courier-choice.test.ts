/**
 * Open-network switch + "my own courier" bookings: couriers opt into
 * marketplace work themselves, and customers name a rider by phone —
 * otherwise the normal pool auto-dispatch applies, unchanged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeRider(opts: { platformStatus?: "pending" | "approved"; selfSignedUp?: boolean; openNetwork?: boolean; noMemberships?: boolean; status?: "available" | "offline" } = {}) {
  // Via the real staff-create route so the stored phone is normalized
  // exactly like production (requested-courier lookup must match it).
  const dispatcher = await makeDispatcher();
  const phone = `87655${uniq().slice(-5)}`;
  const created = await harness.app.inject({
    method: "POST",
    url: "/api/riders",
    headers: dispatcher,
    payload: { name: "Choice Rider", phone, vehicle: "motorcycle" },
  });
  if (created.statusCode !== 200) throw new Error(`rider create failed: ${created.body}`);
  const riderId = (created.json() as { rider: { id: string } }).rider.id;
  const rider = await harness.prisma.rider.update({
    where: { id: riderId },
    data: {
      ...(opts.platformStatus ? { platformStatus: opts.platformStatus } : {}),
      ...(opts.selfSignedUp !== undefined ? { selfSignedUp: opts.selfSignedUp } : {}),
      ...(opts.openNetwork !== undefined ? { openNetwork: opts.openNetwork } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    },
  });
  if (opts.noMemberships) {
    await harness.prisma.riderMembership.deleteMany({ where: { riderId: rider.id } });
  }
  const user = await harness.prisma.user.create({ data: { name: "Choice Rider", passwordHash: "unused", role: "rider" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, phone, auth: { authorization: `Bearer ${token}` } };
}

async function makeDispatcher() {
  const user = await harness.prisma.user.create({ data: { name: `Choice Dispatcher ${uniq()}`, passwordHash: "unused", role: "dispatcher" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "dispatcher" });
  return { authorization: `Bearer ${token}` };
}

async function makeCustomer() {
  return harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Choice Customer", phone: `+18765${uniq().slice(-7)}` } });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-courier-choice");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("open-network switch", () => {
  it("an approved self-signed rider gets nothing until they switch on, then joins the pool", async () => {
    await harness.prisma.business.update({ where: { id: harness.business.id }, data: { courierPool: "both" } });
    try {
      const free = await makeRider({ platformStatus: "approved", selfSignedUp: true, noMemberships: true });
      const dispatcher = await makeDispatcher();
      const customer = await makeCustomer();

      const first = await harness.app.inject({ method: "POST", url: "/api/jobs", headers: dispatcher, payload: { customerId: customer.id, itemSummary: "Before switch" } });
      const job1 = (first.json() as { job: { id: string } }).job.id;
      await new Promise((r) => setTimeout(r, 100));
      expect(await harness.prisma.jobOffer.count({ where: { jobId: job1, riderId: free.rider.id } })).toBe(0);

      const flip = await harness.app.inject({ method: "POST", url: "/api/bearer/profile/open-network", headers: free.auth, payload: { open: true } });
      expect(flip.statusCode).toBe(200);
      expect(flip.json()).toEqual({ ok: true, openNetwork: true });

      const second = await harness.app.inject({ method: "POST", url: "/api/jobs", headers: dispatcher, payload: { customerId: customer.id, itemSummary: "After switch" } });
      const job2 = (second.json() as { job: { id: string } }).job.id;
      await vi.waitFor(async () => expect(await harness.prisma.jobOffer.count({ where: { jobId: job2, riderId: free.rider.id } })).toBe(1));

      const off = await harness.app.inject({ method: "POST", url: "/api/bearer/profile/open-network", headers: free.auth, payload: { open: false } });
      expect(off.json()).toEqual({ ok: true, openNetwork: false });
    } finally {
      await harness.prisma.business.update({ where: { id: harness.business.id }, data: { courierPool: "company" } });
    }
  });

  it("a courier can only flip their own switch", async () => {
    const a = await makeRider();
    const b = await makeRider();
    // B's token flips B's row — there is no route that touches another
    // rider's flag except Platform Admin's PATCH (tested separately).
    const res = await harness.app.inject({ method: "POST", url: "/api/bearer/profile/open-network", headers: b.auth, payload: { open: true } });
    expect(res.statusCode).toBe(200);
    expect((await harness.prisma.rider.findUniqueOrThrow({ where: { id: a.rider.id } })).openNetwork).toBe(false);
    expect((await harness.prisma.rider.findUniqueOrThrow({ where: { id: b.rider.id } })).openNetwork).toBe(true);
  });
});

describe("preferred courier bookings", () => {
  it("staff booking with a phone offers exactly that courier, nobody else", async () => {
    const dispatcher = await makeDispatcher();
    const mine = await makeRider();
    const other = await makeRider();
    const customer = await makeCustomer();
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: dispatcher,
      payload: { customerId: customer.id, itemSummary: "Requested rider", preferredCourierPhone: mine.phone },
    });
    expect(res.statusCode).toBe(200);
    const jobId = (res.json() as { job: { id: string } }).job.id;
    await vi.waitFor(async () => expect(await harness.prisma.jobOffer.count({ where: { jobId, riderId: mine.rider.id } })).toBe(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(await harness.prisma.jobOffer.count({ where: { jobId, riderId: other.rider.id } })).toBe(0);
    const audit = await harness.prisma.auditLog.findFirst({ where: { action: "offer.requested", entityId: jobId } });
    expect(audit).not.toBeNull();
  });

  it("unknown or unavailable courier fails the booking with no stranded job", async () => {
    const dispatcher = await makeDispatcher();
    const customer = await makeCustomer();
    const before = await harness.prisma.job.count({ where: { businessId: harness.business.id } });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: dispatcher,
      payload: { customerId: customer.id, itemSummary: "Ghost rider", preferredCourierPhone: "+1876999888777" },
    });
    expect(res.statusCode).toBe(400);
    expect(await harness.prisma.job.count({ where: { businessId: harness.business.id } })).toBe(before);
  });

  it("public order with courierPhone targets one rider; without it the pool gets it", async () => {
    // Slug-less /api/order resolves the "ronmacrae" business.
    await harness.prisma.business.update({ where: { id: harness.business.id }, data: { slug: "ronmacrae" } });
    const mine = await makeRider();
    const other = await makeRider();
    const payload = {
      name: "Choice Customer",
      phone: `+18765${uniq().slice(-7)}`,
      addressText: "123 Test Street, Kingston",
      items: [{ name: "Parcel", quantity: 1, unitPrice: 1000 }],
    };
    const targeted = await harness.app.inject({ method: "POST", url: "/api/order", payload: { ...payload, courierPhone: mine.phone } });
    expect(targeted.statusCode).toBe(200);
    const jobId = (targeted.json() as { jobId: string }).jobId;
    await vi.waitFor(async () => expect(await harness.prisma.jobOffer.count({ where: { jobId, riderId: mine.rider.id } })).toBe(1));
    expect(await harness.prisma.jobOffer.count({ where: { jobId, riderId: other.rider.id } })).toBe(0);

    const pooled = await harness.app.inject({ method: "POST", url: "/api/order", payload: { ...payload, phone: `+18765${uniq().slice(-7)}` } });
    expect(pooled.statusCode).toBe(200);
    const job2 = (pooled.json() as { jobId: string }).jobId;
    await vi.waitFor(async () => expect(await harness.prisma.jobOffer.count({ where: { jobId: job2 } })).toBeGreaterThan(0));
  });
});

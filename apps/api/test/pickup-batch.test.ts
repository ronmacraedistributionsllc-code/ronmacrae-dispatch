/**
 * Batch pickup: one tap collects every package waiting at the same
 * pickup spot, each running the standard accepted → picked_up →
 * in_transit chain (with the rider-confirmed spot saved), reported
 * per-job — never a silent half-batch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeRider() {
  const rider = await harness.prisma.rider.create({
    data: { name: "Batch Rider", phone: `+18765${uniq().slice(-7)}`, active: true, status: "available", dailyCapacity: 10 },
  });
  const user = await harness.prisma.user.create({ data: { name: "Batch Rider", passwordHash: "unused", role: "rider" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, auth: { authorization: `Bearer ${token}` } };
}

async function makeJob(riderId: string, pickupAddressText: string | null, status: "accepted" | "in_transit" = "accepted") {
  const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Batch Customer", phone: `+18765${uniq().slice(-7)}` } });
  return harness.prisma.job.create({
    data: { businessId: harness.business.id, customerId: customer.id, jobNumber: `BAT-${uniq()}`, status, riderId, pickupAddressText },
  });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-pickup-batch");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("POST /api/bearer/jobs/pickup-batch", () => {
  it("requires authentication", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/api/bearer/jobs/pickup-batch", payload: { jobIds: ["x"] } });
    expect(res.statusCode).toBe(401);
  });

  it("collects every same-spot package, chains each onward, saves the confirmed spot", async () => {
    const { auth, rider } = await makeRider();
    const a = await makeJob(rider.id, "12 Market Street");
    const b = await makeJob(rider.id, "12 Market Street");
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/bearer/jobs/pickup-batch",
      headers: auth,
      payload: { jobIds: [a.id, b.id], pickupPoint: { lat: 18.015, lng: -76.798 }, note: "all here" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [{ jobId: a.id, ok: true }, { jobId: b.id, ok: true }] });
    for (const id of [a.id, b.id]) {
      const row = await harness.prisma.job.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("in_transit");
      expect(row.pickupPoint).not.toBeNull();
    }
    const audit = await harness.prisma.auditLog.findFirst({ where: { action: "job.pickup_batch", entityId: rider.id } });
    expect(audit).not.toBeNull();
  });

  it("refuses mixed pickup spots without moving anything", async () => {
    const { auth, rider } = await makeRider();
    const a = await makeJob(rider.id, "12 Market Street");
    const b = await makeJob(rider.id, "99 Other Road");
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/bearer/jobs/pickup-batch",
      headers: auth,
      payload: { jobIds: [a.id, b.id] },
    });
    expect(res.statusCode).toBe(400);
    expect((await harness.prisma.job.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("accepted");
    expect((await harness.prisma.job.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("accepted");
  });

  it("refuses jobs that already moved on, and jobs that aren't yours", async () => {
    const { auth, rider } = await makeRider();
    const moved = await makeJob(rider.id, "12 Market Street", "in_transit");
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/bearer/jobs/pickup-batch",
      headers: auth,
      payload: { jobIds: [moved.id] },
    });
    expect(res.statusCode).toBe(409);

    const other = await makeRider();
    const theirs = await makeJob(other.rider.id, "12 Market Street");
    const foreign = await harness.app.inject({
      method: "POST",
      url: "/api/bearer/jobs/pickup-batch",
      headers: auth,
      payload: { jobIds: [theirs.id] },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("replays idempotently on the same key", async () => {
    const { auth, rider } = await makeRider();
    const a = await makeJob(rider.id, "12 Market Street");
    const headers = { ...auth, "idempotency-key": `batch-${uniq()}-key1` };
    const first = await harness.app.inject({ method: "POST", url: "/api/bearer/jobs/pickup-batch", headers, payload: { jobIds: [a.id] } });
    expect(first.statusCode).toBe(200);
    const second = await harness.app.inject({ method: "POST", url: "/api/bearer/jobs/pickup-batch", headers, payload: { jobIds: [a.id] } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });
});

describe("single pickup with a confirmed spot", () => {
  it("saves pickupPoint on the picked_up transition", async () => {
    const { auth, rider } = await makeRider();
    const job = await makeJob(rider.id, "12 Market Street");
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${job.id}/transition`,
      headers: auth,
      payload: { to: "picked_up", pickupPoint: { lat: 18.02, lng: -76.8 } },
    });
    expect(res.statusCode).toBe(200);
    expect((await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).pickupPoint).not.toBeNull();
  });
});

/**
 * Public customer tracking (GET /api/tracking/:token) — restricted
 * rider-location display (Stage 22 / spec 4). Real Fastify app + real
 * sqlite db (see test/helpers/test-app.ts).
 *
 * Regression coverage for a real bug: the endpoint used to show a rider's
 * last-known position whenever `job.riderId` was set and *any* location row
 * existed, with no regard to the job's actual status — so a customer could
 * see a rider's position from before the job was even picked up, or long
 * after it was delivered/cancelled and the rider had moved on to other
 * work. This file had no direct coverage before Stage 22.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeCustomer(h: TestHarness) {
  return h.prisma.customer.create({ data: { businessId: h.business.id, name: "Track Test Customer", phone: `+1876580${uniq()}` } });
}

async function makeRiderWithLocation(h: TestHarness) {
  const rider = await h.prisma.rider.create({ data: { name: "Track Test Rider", phone: `+1876581${uniq()}`, active: true, status: "available" } });
  await h.prisma.riderLocation.create({
    data: { riderId: rider.id, point: { lat: 18.0, lng: -76.8 }, trackingState: "active", clientSeq: 1, at: new Date() },
  });
  return rider;
}

async function jobLink(h: TestHarness, jobId: string) {
  return h.prisma.trackingLink.create({ data: { jobId, token: `tok-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000) } });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-tracking");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("restricted rider-location display", () => {
  it("shows no location before the job is picked up, even with a rider assigned who has reported a position", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRiderWithLocation(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "assigned" } });
    const link = await jobLink(harness, job.id);

    const res = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { location: { point: unknown } };
    expect(body.location.point).toBeNull();
  });

  it("shows the live location while the job is actively out with the rider", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRiderWithLocation(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "in_transit" } });
    const link = await jobLink(harness, job.id);

    const res = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}` });
    const body = res.json() as { location: { point: { lat: number; lng: number } | null } };
    expect(body.location.point).toEqual({ lat: 18.0, lng: -76.8 });
  });

  it("hides the location again once the job is delivered — it used to keep showing forever", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRiderWithLocation(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered" } });
    const link = await jobLink(harness, job.id);

    const res = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}` });
    const body = res.json() as { location: { point: unknown } };
    expect(body.location.point).toBeNull();
  });

  it("hides the location on a cancelled job even with a rider and a fresh location row on file", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRiderWithLocation(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "cancelled" } });
    const link = await jobLink(harness, job.id);

    const res = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}` });
    const body = res.json() as { location: { point: unknown } };
    expect(body.location.point).toBeNull();
  });

  it("still shows the rider's name (not their location) once assigned but before pickup", async () => {
    const customer = await makeCustomer(harness);
    const rider = await makeRiderWithLocation(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "accepted" } });
    const link = await jobLink(harness, job.id);

    const res = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}` });
    const body = res.json() as { rider: { name: string } | null; location: { point: unknown } };
    expect(body.rider?.name).toBe(rider.name);
    expect(body.location.point).toBeNull();
  });
});

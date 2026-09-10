/**
 * Rider route queue (Stage 13 / spec 5B): the rider-driven reorder endpoint.
 * Real Fastify app + real sqlite db (see test/helpers/test-app.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeCustomer(h: TestHarness) {
  return h.prisma.customer.create({ data: { name: "Test Customer", phone: `+1876555${uniq()}` } });
}

async function makeRider(h: TestHarness) {
  const rider = await h.prisma.rider.create({ data: { name: "Queue Test Rider", phone: `+1876558${uniq()}`, active: true, status: "available" } });
  const user = await h.prisma.user.create({ data: { name: rider.name, passwordHash: "unused-in-tests", role: "rider" } });
  const token = await h.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, token };
}

async function dispatcherToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: "Dee Dispatcher", passwordHash: "unused-in-tests", role: "dispatcher" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "dispatcher" });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-route-queue");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("rider job reorder", () => {
  it("sets routeSeq to match the submitted order, for exactly the rider's active jobs", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token } = await makeRider(harness);
    const jobA = await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "assigned" } });
    const jobB = await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "accepted" } });
    const jobC = await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "picked_up" } });

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/bearer/jobs/reorder",
      headers: { authorization: `Bearer ${token}` },
      payload: { jobIds: [jobC.id, jobA.id, jobB.id] },
    });
    expect(res.statusCode).toBe(200);

    const rows = await harness.prisma.job.findMany({ where: { id: { in: [jobA.id, jobB.id, jobC.id] } } });
    const seqOf = (id: string) => rows.find((r) => r.id === id)!.routeSeq;
    expect(seqOf(jobC.id)).toBe(0);
    expect(seqOf(jobA.id)).toBe(1);
    expect(seqOf(jobB.id)).toBe(2);
  });

  it("rejects a reorder that omits one of the rider's active jobs", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token } = await makeRider(harness);
    const jobA = await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "assigned" } });
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "accepted" } }); // jobB, deliberately omitted below

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/bearer/jobs/reorder",
      headers: { authorization: `Bearer ${token}` },
      payload: { jobIds: [jobA.id] },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects a reorder that includes a job that isn't the rider's own", async () => {
    const customer = await makeCustomer(harness);
    const { rider: riderA, token: tokenA } = await makeRider(harness);
    const { rider: riderB } = await makeRider(harness);
    const jobA = await harness.prisma.job.create({ data: { customerId: customer.id, riderId: riderA.id, status: "assigned" } });
    const jobB = await harness.prisma.job.create({ data: { customerId: customer.id, riderId: riderB.id, status: "assigned" } });

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/bearer/jobs/reorder",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { jobIds: [jobA.id, jobB.id] },
    });
    expect(res.statusCode).toBe(409);
    // Confirm it didn't partially apply either.
    const rowB = await harness.prisma.job.findUniqueOrThrow({ where: { id: jobB.id } });
    expect(rowB.routeSeq).toBeNull();
  });

  it("a dispatcher cannot reorder a rider's queue for them — only the rider can", async () => {
    const customer = await makeCustomer(harness);
    const { rider } = await makeRider(harness);
    const jobA = await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "assigned" } });
    const staffTok = await dispatcherToken(harness);

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/bearer/jobs/reorder",
      headers: { authorization: `Bearer ${staffTok}` },
      payload: { jobIds: [jobA.id] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("dispatchers can view a rider's active jobs (to inspect their queue), read-only", async () => {
    const customer = await makeCustomer(harness);
    const { rider } = await makeRider(harness);
    await harness.prisma.job.create({ data: { customerId: customer.id, riderId: rider.id, status: "assigned" } });
    const staffTok = await dispatcherToken(harness);

    const res = await harness.app.inject({
      method: "GET",
      url: `/api/jobs?riderId=${rider.id}&status=assigned,accepted,picked_up,in_transit,delivering`,
      headers: { authorization: `Bearer ${staffTok}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { jobs: { riderId: string | null }[] };
    expect(body.jobs.length).toBeGreaterThan(0);
    expect(body.jobs.every((j) => j.riderId === rider.id)).toBe(true);
  });
});

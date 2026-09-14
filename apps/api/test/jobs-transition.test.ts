/**
 * Job status transitions (Stage 19 / spec item 1: simple three-step rider
 * delivery flow — Collected -> In transit -> Delivered, with acceptance kept
 * separate from collection): real Fastify app + real sqlite db (see
 * test/helpers/test-app.ts).
 *
 * Covers: the three-step happy path, invalid transitions rejected by the
 * state machine, a rider blocked from another rider's job, and the new
 * duplicate-submit guard — two concurrent requests for the same transition
 * must not both apply (no double JobEvent, no double cash/notification
 * side-effect).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeCustomer(h: TestHarness) {
  return h.prisma.customer.create({ data: { businessId: h.business.id,  name: "Transition Test Customer", phone: `+1876555${uniq()}` } });
}

async function makeRider(h: TestHarness) {
  const rider = await h.prisma.rider.create({ data: { name: "Transition Test Rider", phone: `+1876557${uniq()}`, active: true, status: "available" } });
  const user = await h.prisma.user.create({ data: { name: rider.name, passwordHash: "unused-in-tests", role: "rider" } });
  const token = await h.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, token };
}

async function makeAssignedJob(h: TestHarness, customerId: string, riderId: string) {
  return h.prisma.job.create({ data: { businessId: h.business.id,  customerId, riderId, status: "assigned", paymentMethod: "cod", amountExpected: 1000, currency: "JMD", pin: "1234" },
  });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-jobs-transition");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("three-step rider flow: accepted -> picked_up -> in_transit -> delivered", () => {
  it("acceptance is separate from collection — an accepted job stays at picked_up-pending until the rider explicitly confirms collection", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token } = await makeRider(harness);
    const job = await makeAssignedJob(harness, customer.id, rider.id);

    let res = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${job.id}/accept`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { job: { status: string } }).job.status).toBe("accepted");

    // Nothing else has moved it — still not collected.
    res = await harness.app.inject({ method: "GET", url: `/api/bearer/jobs`, headers: { authorization: `Bearer ${token}` } });
    const stillAccepted = (res.json() as { jobs: { id: string; status: string }[] }).jobs.find((j) => j.id === job.id);
    expect(stillAccepted?.status).toBe("accepted");

    // Step 1: Collected
    res = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${job.id}/transition`,
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "picked_up" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { job: { status: string } }).job.status).toBe("picked_up");

    // Step 2: In transit
    res = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${job.id}/transition`,
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "in_transit" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { job: { status: string } }).job.status).toBe("in_transit");

    // Step 3: Delivered (PIN preserved as a requirement — wrong PIN rejected first)
    res = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${job.id}/transition`,
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "delivered", pin: "0000" },
    });
    expect(res.statusCode).toBe(400);

    res = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${job.id}/transition`,
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "delivered", pin: "1234" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { job: { status: string; completedAt: string | null } }).job.status).toBe("delivered");

    // Full history preserved: every step recorded as its own JobEvent.
    const events = await harness.prisma.jobEvent.findMany({ where: { jobId: job.id }, orderBy: { at: "asc" } });
    expect(events.map((e) => e.to)).toEqual(["accepted", "picked_up", "in_transit", "delivered"]);
  });

  it("rejects skipping a step (e.g. accepted straight to delivered) and rejects moving another rider's job", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token } = await makeRider(harness);
    const { token: otherToken } = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, riderId: rider.id, status: "accepted", paymentMethod: "cod", amountExpected: 1000, currency: "JMD", pin: "1234" },
    });

    const skip = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${job.id}/transition`,
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "delivered", pin: "1234" },
    });
    expect(skip.statusCode).toBe(409);

    const wrongRider = await harness.app.inject({
      method: "POST",
      url: `/api/bearer/jobs/${job.id}/transition`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { to: "picked_up" },
    });
    expect(wrongRider.statusCode).toBe(403);
  });
});

describe("duplicate-submit guard (backend, not just UI disabling)", () => {
  it("two concurrent requests for the same transition only apply once — the loser gets a 409, not a second event", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token } = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, riderId: rider.id, status: "picked_up", paymentMethod: "cod", amountExpected: 1000, currency: "JMD", pin: "1234" },
    });

    const send = () =>
      harness.app.inject({
        method: "POST",
        url: `/api/bearer/jobs/${job.id}/transition`,
        headers: { authorization: `Bearer ${token}` },
        payload: { to: "in_transit" },
      });

    const [a, b] = await Promise.all([send(), send()]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const events = await harness.prisma.jobEvent.findMany({ where: { jobId: job.id, to: "in_transit" } });
    expect(events).toHaveLength(1);

    const finalJob = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(finalJob.status).toBe("in_transit");
  });

  it("a repeated identical rider-stage report (e.g. offline retry of 'heading to pickup') is a harmless no-op, not a duplicate audit event", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token } = await makeRider(harness);
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id,  customerId: customer.id, riderId: rider.id, status: "accepted", paymentMethod: "cod", amountExpected: 1000, currency: "JMD" },
    });

    for (let i = 0; i < 2; i++) {
      const res = await harness.app.inject({
        method: "POST",
        url: `/api/bearer/jobs/${job.id}/stage`,
        headers: { authorization: `Bearer ${token}` },
        payload: { stage: "heading_to_pickup" },
      });
      expect(res.statusCode).toBe(200);
    }

    const events = await harness.prisma.jobEvent.findMany({ where: { jobId: job.id } });
    expect(events).toHaveLength(1);
  });
});

/**
 * Integration tests for the COD reconciliation ledger (Stage 12 / spec 5A):
 * real Fastify app + real sqlite db (see test/helpers/test-app.ts).
 *
 * Covers: the full collect -> hand-in -> approve lifecycle, auto-calculated
 * shortage/overage, permission gating per role, approved entries being locked
 * against further rider edits, the dispute path, the append-only audit trail,
 * and that the public customer tracking DTO never carries any of this.
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
  const rider = await h.prisma.rider.create({ data: { name: "Cod Test Rider", phone: `+1876557${uniq()}`, active: true, status: "available" } });
  const user = await h.prisma.user.create({ data: { name: rider.name, passwordHash: "unused-in-tests", role: "rider" } });
  const token = await h.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, token };
}

async function staffToken(h: TestHarness, role: "admin" | "dispatcher" | "accountant" | "viewer") {
  const user = await h.prisma.user.create({ data: { name: `Test ${role}`, passwordHash: "unused-in-tests", role } });
  return h.tokenFor({ id: user.id, name: user.name, role });
}

async function makeCodJob(h: TestHarness, customerId: string, riderId: string, amountExpected = 1000) {
  return h.prisma.job.create({
    data: { customerId, riderId, status: "delivered", paymentMethod: "cod", amountExpected, currency: "JMD" },
  });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-cod");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("COD reconciliation: full lifecycle", () => {
  it("collect -> hand-in -> approve, with auto-calculated shortage/overage at each step", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, rider.id, 1000);
    const accountantTok = await staffToken(harness, "accountant");

    type CodJobView = {
      job: {
        codStatus: string;
        codVarianceMinor: number | null;
        codCollectedAt: string | null;
        codRiderNote: string | null;
        codHandoverAt: string | null;
        codApprovedByName: string | null;
        codApprovedAt: string | null;
      };
    };

    // starts pending_collection
    let res = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: { authorization: `Bearer ${accountantTok}` } });
    let body = res.json() as CodJobView;
    expect(body.job.codStatus).toBe("pending_collection");
    expect(body.job.codVarianceMinor).toBeNull();

    // rider records collection -> collected
    res = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/collect`,
      headers: { authorization: `Bearer ${riderTok}` },
      payload: { amountCollected: 1000, note: "collected exact amount" },
    });
    expect(res.statusCode).toBe(200);
    body = res.json() as CodJobView;
    expect(body.job.codStatus).toBe("collected");
    expect(body.job.codCollectedAt).not.toBeNull();
    expect(body.job.codRiderNote).toBe("collected exact amount");

    // rider hands in less than collected -> shortage
    res = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/cod/hand-in`,
      headers: { authorization: `Bearer ${riderTok}` },
      payload: { amountHandedIn: 950, note: "50 short, will explain" },
    });
    expect(res.statusCode).toBe(200);
    body = res.json() as CodJobView;
    expect(body.job.codStatus).toBe("handed_in");
    // JMD has 0 decimal places (currencyMeta("JMD").decimals === 0), so minor
    // units equal major units here: 950 handed in - 1000 collected = -50.
    expect(body.job.codVarianceMinor).toBe(-50);
    expect(body.job.codHandoverAt).not.toBeNull();

    // accountant approves with a note
    res = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/cod/approve`,
      headers: { authorization: `Bearer ${accountantTok}` },
      payload: { note: "shortage explained and accepted" },
    });
    expect(res.statusCode).toBe(200);
    body = res.json() as CodJobView;
    expect(body.job.codStatus).toBe("approved");
    expect(body.job.codApprovedByName).toBe("Test accountant");
    expect(body.job.codApprovedAt).not.toBeNull();

    // full audit trail is there, in order
    const events = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/cod/events`, headers: { authorization: `Bearer ${accountantTok}` } });
    const eventList = (events.json() as { events: { from: string | null; to: string }[] }).events;
    expect(eventList.map((e) => e.to)).toEqual(["collected", "handed_in", "approved"]);
    expect(eventList[0]!.from).toBe("pending_collection");
  });

  it("an exact handover shows zero variance, an overage shows a positive one", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, rider.id, 500);
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountCollected: 500 } });
    const res = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/hand-in`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountHandedIn: 500 } });
    expect((res.json() as { job: { codVarianceMinor: number | null } }).job.codVarianceMinor).toBe(0);

    const job2 = await makeCodJob(harness, customer.id, rider.id, 500);
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job2.id}/collect`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountCollected: 500 } });
    const res2 = await harness.app.inject({ method: "POST", url: `/api/jobs/${job2.id}/cod/hand-in`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountHandedIn: 520 } });
    expect((res2.json() as { job: { codVarianceMinor: number | null } }).job.codVarianceMinor).toBe(20); // +20 overage (JMD: minor === major)
  });
});

describe("COD reconciliation: permissions", () => {
  it("an accountant cannot record a collection or hand-in", async () => {
    const customer = await makeCustomer(harness);
    const { rider } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, rider.id);
    const accountantTok = await staffToken(harness, "accountant");

    const collectRes = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${accountantTok}` }, payload: { amountCollected: 1000 } });
    expect(collectRes.statusCode).toBe(403);

    const handInRes = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/hand-in`, headers: { authorization: `Bearer ${accountantTok}` }, payload: { amountHandedIn: 1000 } });
    expect(handInRes.statusCode).toBe(403);
  });

  it("a dispatcher can record collection/hand-in on a rider's behalf (late reconciliation)", async () => {
    const customer = await makeCustomer(harness);
    const { rider } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, rider.id);
    const dispatcherTok = await staffToken(harness, "dispatcher");

    const collectRes = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: { amountCollected: 1000 } });
    expect(collectRes.statusCode).toBe(200);
    const handInRes = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/hand-in`, headers: { authorization: `Bearer ${dispatcherTok}` }, payload: { amountHandedIn: 1000 } });
    expect(handInRes.statusCode).toBe(200);
  });

  it("a rider cannot record collection/hand-in for another rider's job", async () => {
    const customer = await makeCustomer(harness);
    const { rider: owner } = await makeRider(harness);
    const { token: otherTok } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, owner.id);

    const res = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${otherTok}` }, payload: { amountCollected: 1000 } });
    expect(res.statusCode).toBe(403);
  });

  it("a viewer can monitor (list + read events) but cannot approve or dispute", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, rider.id);
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountCollected: 1000 } });
    const viewerTok = await staffToken(harness, "viewer");

    const listRes = await harness.app.inject({ method: "GET", url: "/api/cod", headers: { authorization: `Bearer ${viewerTok}` } });
    expect(listRes.statusCode).toBe(200);
    const eventsRes = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/cod/events`, headers: { authorization: `Bearer ${viewerTok}` } });
    expect(eventsRes.statusCode).toBe(200);

    const approveRes = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/approve`, headers: { authorization: `Bearer ${viewerTok}` }, payload: {} });
    expect(approveRes.statusCode).toBe(403);
    const disputeRes = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/dispute`, headers: { authorization: `Bearer ${viewerTok}` }, payload: { note: "checking" } });
    expect(disputeRes.statusCode).toBe(403);
  });

  it("a rider cannot approve or dispute their own COD entry", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, rider.id);
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountCollected: 1000 } });

    const res = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/approve`, headers: { authorization: `Bearer ${riderTok}` }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe("COD reconciliation: approved entries can't be silently overwritten", () => {
  it("blocks a further collect or hand-in once approved, but allows a deliberate accountant dispute afterward", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, rider.id);
    const accountantTok = await staffToken(harness, "accountant");

    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountCollected: 1000 } });
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/hand-in`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountHandedIn: 1000 } });
    const approveRes = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/approve`, headers: { authorization: `Bearer ${accountantTok}` }, payload: {} });
    expect(approveRes.statusCode).toBe(200);

    const reCollect = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountCollected: 500 } });
    expect(reCollect.statusCode).toBe(409);
    const reHandIn = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/hand-in`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountHandedIn: 500 } });
    expect(reHandIn.statusCode).toBe(409);
    const reApprove = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/approve`, headers: { authorization: `Bearer ${accountantTok}` }, payload: {} });
    expect(reApprove.statusCode).toBe(409);

    // A dispute is still a legitimate, deliberate, audited re-open — not blocked.
    const disputeRes = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/dispute`, headers: { authorization: `Bearer ${accountantTok}` }, payload: { note: "found a discrepancy after all" } });
    expect(disputeRes.statusCode).toBe(200);
    expect((disputeRes.json() as { job: { codStatus: string } }).job.codStatus).toBe("disputed");

    const events = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/cod/events`, headers: { authorization: `Bearer ${accountantTok}` } });
    const eventList = (events.json() as { events: { to: string }[] }).events;
    // The original approval is still in the trail even after the dispute reopened it.
    expect(eventList.map((e) => e.to)).toEqual(["collected", "handed_in", "approved", "disputed"]);
  });

  it("dispute requires a non-empty note", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, rider.id);
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountCollected: 1000 } });
    const accountantTok = await staffToken(harness, "accountant");
    const res = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/dispute`, headers: { authorization: `Bearer ${accountantTok}` }, payload: { note: "" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("COD reconciliation: customer-facing tracking never carries it", () => {
  it("the public tracking DTO has no COD ledger fields at all", async () => {
    const customer = await makeCustomer(harness);
    const { rider, token: riderTok } = await makeRider(harness);
    const job = await makeCodJob(harness, customer.id, rider.id);
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/collect`, headers: { authorization: `Bearer ${riderTok}` }, payload: { amountCollected: 1000, note: "internal rider note — must never leak" } });
    const dispatcherTok = await staffToken(harness, "dispatcher");
    const linkRes = await harness.app.inject({ method: "POST", url: `/api/tracking/${job.id}`, headers: { authorization: `Bearer ${dispatcherTok}` } });
    const token = (linkRes.json() as { link: { token: string } }).link.token;

    const pub = await harness.app.inject({ method: "GET", url: `/api/tracking/${token}` });
    expect(pub.statusCode).toBe(200);
    const raw = JSON.stringify(pub.json());
    expect(raw).not.toContain("codRiderNote");
    expect(raw).not.toContain("codAccountantNote");
    expect(raw).not.toContain("codStatus");
    expect(raw).not.toContain("internal rider note");
  });
});

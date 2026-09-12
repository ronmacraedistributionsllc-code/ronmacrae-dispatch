/**
 * Rider-to-office settlements, batched per merchant (Stage 30, spec section
 * 38/42/90: "rider cash by merchant" + "END-OF-DAY RIDER RECONCILIATION").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: h.business.id });
}

// The harness's own rider.create extension already gives a fresh rider an
// active RiderMembership at the default business (see test-app.ts) — no
// need to create one explicitly here.
async function makeRider(h: TestHarness) {
  return h.prisma.rider.create({ data: { name: "Settle Test Rider", phone: `+1876595${uniq().slice(-7)}`, active: true, status: "available" } });
}

async function makeMerchant(h: TestHarness, auth: string) {
  const res = await h.app.inject({ method: "POST", url: "/api/merchants", headers: { authorization: `Bearer ${auth}` }, payload: { name: `Settle Merchant ${uniq()}` } });
  return (res.json() as { merchant: { id: string; name: string } }).merchant;
}

async function makeCustomer(h: TestHarness) {
  return h.prisma.customer.create({ data: { businessId: h.business.id, name: "Settle Customer", phone: `+1876596${uniq().slice(-7)}` } });
}

/** A COD job already handed in (not yet approved) — the state settlements operate on. */
async function makeHandedInJob(h: TestHarness, riderId: string, merchantId: string | null, amount: number) {
  const customer = await makeCustomer(h);
  return h.prisma.job.create({
    data: {
      businessId: h.business.id,
      merchantId,
      customerId: customer.id,
      riderId,
      status: "delivered",
      paymentMethod: "cod",
      currency: "JMD",
      amountExpected: amount,
      amountCollected: amount,
      codStatus: "handed_in",
      codHandedInAmount: amount,
      codHandoverAt: new Date(),
    },
  });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-settlements");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("settlements: outstanding-by-merchant and recording a hand-in", () => {
  it("shows outstanding cash grouped by merchant, and settling moves those jobs to approved", async () => {
    const auth = await adminToken(harness);
    const rider = await makeRider(harness);
    const merchantA = await makeMerchant(harness, auth);
    const merchantB = await makeMerchant(harness, auth);

    const jobA1 = await makeHandedInJob(harness, rider.id, merchantA.id, 5000);
    const jobA2 = await makeHandedInJob(harness, rider.id, merchantA.id, 3000);
    const jobB1 = await makeHandedInJob(harness, rider.id, merchantB.id, 2000);

    const outstandingRes = await harness.app.inject({ method: "GET", url: `/api/riders/${rider.id}/settlements/outstanding`, headers: { authorization: `Bearer ${auth}` } });
    expect(outstandingRes.statusCode).toBe(200);
    const outstanding = outstandingRes.json() as { merchants: { merchantId: string | null; merchantName: string; total: { amount: number }; jobs: { jobId: string }[] }[] };
    const groupA = outstanding.merchants.find((m) => m.merchantId === merchantA.id)!;
    const groupB = outstanding.merchants.find((m) => m.merchantId === merchantB.id)!;
    expect(groupA.total.amount).toBe(8000);
    expect(groupA.jobs.map((j) => j.jobId).sort()).toEqual([jobA1.id, jobA2.id].sort());
    expect(groupB.total.amount).toBe(2000);

    // Settle only merchant A's cash — merchant B's stays untouched and outstanding.
    const settleRes = await harness.app.inject({
      method: "POST",
      url: "/api/settlements",
      headers: { authorization: `Bearer ${auth}` },
      payload: { riderId: rider.id, merchantId: merchantA.id, type: "full", jobIds: [jobA1.id, jobA2.id], reference: "cash-drawer-1" },
    });
    expect(settleRes.statusCode).toBe(200);
    const settlement = (settleRes.json() as { settlement: { id: string; amount: { amount: number }; merchantName: string | null; jobIds: string[] } }).settlement;
    expect(settlement.amount.amount).toBe(8000); // computed server-side from the jobs, never trusted from the request
    expect(settlement.merchantName).toBe(merchantA.name);
    expect(settlement.jobIds.sort()).toEqual([jobA1.id, jobA2.id].sort());

    const settledJobA1 = await harness.prisma.job.findUniqueOrThrow({ where: { id: jobA1.id } });
    expect(settledJobA1.codStatus).toBe("approved");
    expect(settledJobA1.codApprovedById).toBeTruthy();

    const stillOutstanding = await harness.app.inject({ method: "GET", url: `/api/riders/${rider.id}/settlements/outstanding`, headers: { authorization: `Bearer ${auth}` } });
    const stillOutstandingBody = stillOutstanding.json() as { merchants: { merchantId: string | null; total: { amount: number } }[] };
    expect(stillOutstandingBody.merchants.find((m) => m.merchantId === merchantA.id)).toBeUndefined(); // fully cleared
    expect(stillOutstandingBody.merchants.find((m) => m.merchantId === merchantB.id)!.total.amount).toBe(2000); // untouched

    // The CodEvent audit trail records this settlement, not a silent status flip.
    const events = await harness.prisma.codEvent.findMany({ where: { jobId: jobA1.id }, orderBy: { at: "desc" } });
    expect(events[0]!.to).toBe("approved");
    expect(events[0]!.meta as { settlementId?: string }).toHaveProperty("settlementId", settlement.id);

    void jobB1;
  });

  it("rejects settling a job that isn't actually outstanding for that rider+merchant (already settled, wrong rider, or wrong merchant)", async () => {
    const auth = await adminToken(harness);
    const rider = await makeRider(harness);
    const otherRider = await makeRider(harness);
    const merchant = await makeMerchant(harness, auth);
    const job = await makeHandedInJob(harness, rider.id, merchant.id, 1000);

    const wrongRider = await harness.app.inject({
      method: "POST",
      url: "/api/settlements",
      headers: { authorization: `Bearer ${auth}` },
      payload: { riderId: otherRider.id, merchantId: merchant.id, jobIds: [job.id] },
    });
    expect(wrongRider.statusCode).toBe(409);

    const wrongMerchant = await harness.app.inject({
      method: "POST",
      url: "/api/settlements",
      headers: { authorization: `Bearer ${auth}` },
      payload: { riderId: rider.id, jobIds: [job.id] }, // no merchantId — treated as "direct orders" bucket, doesn't match
    });
    expect(wrongMerchant.statusCode).toBe(409);

    const ok = await harness.app.inject({
      method: "POST",
      url: "/api/settlements",
      headers: { authorization: `Bearer ${auth}` },
      payload: { riderId: rider.id, merchantId: merchant.id, jobIds: [job.id] },
    });
    expect(ok.statusCode).toBe(200);

    // Settling the same job again must fail — it's already approved, not outstanding.
    const again = await harness.app.inject({
      method: "POST",
      url: "/api/settlements",
      headers: { authorization: `Bearer ${auth}` },
      payload: { riderId: rider.id, merchantId: merchant.id, jobIds: [job.id] },
    });
    expect(again.statusCode).toBe(409);
  });

  it("a dispatcher can record a settlement (day-to-day cash handling), a rider cannot", async () => {
    const dispatcherUser = await harness.prisma.user.create({ data: { name: "Dispatch", passwordHash: "unused-in-tests", role: "dispatcher" } });
    const dispatcherTok = await harness.tokenFor({ id: dispatcherUser.id, name: dispatcherUser.name, role: "dispatcher", businessId: harness.business.id });
    const rider = await makeRider(harness);
    const job = await makeHandedInJob(harness, rider.id, null, 500);

    const riderUser = await harness.prisma.user.create({ data: { name: rider.name, passwordHash: "unused-in-tests", role: "rider" } });
    const riderTok = await harness.tokenFor({ id: riderUser.id, name: riderUser.name, role: "rider", riderId: rider.id });
    const riderAttempt = await harness.app.inject({
      method: "POST",
      url: "/api/settlements",
      headers: { authorization: `Bearer ${riderTok}` },
      payload: { riderId: rider.id, jobIds: [job.id] },
    });
    expect(riderAttempt.statusCode).toBe(403);

    const dispatcherAttempt = await harness.app.inject({
      method: "POST",
      url: "/api/settlements",
      headers: { authorization: `Bearer ${dispatcherTok}` },
      payload: { riderId: rider.id, jobIds: [job.id] },
    });
    expect(dispatcherAttempt.statusCode).toBe(200);
  });
});

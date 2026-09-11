/**
 * Stage 28 — final cross-stage verification. Every individual stage
 * (19-27) has its own dedicated tests; this file is specifically for the
 * seams *between* stages that a single stage's own test suite wouldn't
 * necessarily exercise — the kind of gap a feature built later (e.g.
 * Stage 25's CustomerAccount) can leave in something built earlier (e.g.
 * Stage 23's identity merge) without either stage's own tests ever
 * catching it, because neither one was looking at the other.
 *
 * The identity-merge / CustomerAccount cascade bug this review actually
 * found is covered directly in customer-identity.test.ts (the fix lives
 * in customer-identity.ts, right next to what it fixes) — this file
 * covers the other seams checked during the same pass, where nothing
 * turned out to be broken but the interaction was worth pinning down
 * with a real test rather than just reasoning about it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { normalizePhone } from "../src/lib/phone.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;
const freshPhone = () => `876${uniq().slice(-7)}`;

async function staffToken(role: "admin" | "dispatcher" = "admin") {
  const user = await harness.prisma.user.create({ data: { name: `Stage28 ${uniq()}`, passwordHash: "unused-in-tests", role } });
  await harness.prisma.staffMembership.create({ data: { userId: user.id, businessId: harness.business.id, role, active: true } });
  return harness.tokenFor({ id: user.id, name: user.name, role, businessId: harness.business.id });
}

async function dashboardTokenFor(rawPhone: string): Promise<string> {
  const phone = normalizePhone(rawPhone)!;
  await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/request-code", payload: { phone: rawPhone } });
  const row = await harness.prisma.outboxMessage.findFirst({ where: { template: "customer_dashboard_code", to: phone }, orderBy: { createdAt: "desc" } });
  const code = (row!.params as { code: string }).code;
  const res = await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/verify", payload: { phone: rawPhone, code } });
  return (res.json() as { token: string }).token;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-stage28-integration");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("trash (Stage 26) + customer dashboard (Stage 22)", () => {
  it("a trashed job disappears from the customer's own cross-business dashboard, and restoring brings it straight back", async () => {
    const admin = await staffToken();
    const rawPhone = freshPhone();
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Stage28 Customer", phone: rawPhone } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, status: "cancelled" } });
    // Link the customer's identity the same way the real create/update
    // path does (customers.ts) — this test creates the Customer row
    // directly via Prisma, so it has to resolve the identity itself, same
    // as customer-dashboard.test.ts's own convention.
    const identity = await harness.prisma.customerIdentity.upsert({
      where: { normalizedPhone: normalizePhone(rawPhone)! },
      create: { normalizedPhone: normalizePhone(rawPhone)! },
      update: {},
    });
    await harness.prisma.customer.update({ where: { id: customer.id }, data: { identityId: identity.id } });

    const token = await dashboardTokenFor(rawPhone);
    const before = await harness.app.inject({ method: "GET", url: "/api/customer-dashboard", headers: { authorization: `Bearer ${token}` } });
    expect((before.json() as { history: { jobId: string }[] }).history.map((j) => j.jobId)).toContain(job.id);

    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` } });
    const afterDelete = await harness.app.inject({ method: "GET", url: "/api/customer-dashboard", headers: { authorization: `Bearer ${token}` } });
    const allAfterDelete = [...(afterDelete.json() as { active: { jobId: string }[]; history: { jobId: string }[] }).active, ...(afterDelete.json() as { active: { jobId: string }[]; history: { jobId: string }[] }).history];
    expect(allAfterDelete.map((j) => j.jobId)).not.toContain(job.id);

    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/restore`, headers: { authorization: `Bearer ${admin}` } });
    const afterRestore = await harness.app.inject({ method: "GET", url: "/api/customer-dashboard", headers: { authorization: `Bearer ${token}` } });
    expect((afterRestore.json() as { history: { jobId: string }[] }).history.map((j) => j.jobId)).toContain(job.id);
  });
});

describe("trash (Stage 26) + rider cash profile (Stage 27)", () => {
  it("a trashed job's already-confirmed COD still counts in the rider's cash profile, same as reports/cod — the ledger is never affected by trash", async () => {
    const admin = await staffToken();
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Stage28 Cash Customer", phone: `+1876${uniq()}` } });
    const rider = await harness.prisma.rider.create({ data: { name: "Stage28 Cash Rider", phone: `+1876${uniq()}`, active: true, status: "available" } });
    await harness.prisma.riderMembership.upsert({
      where: { riderId_businessId: { riderId: rider.id, businessId: harness.business.id } },
      create: { riderId: rider.id, businessId: harness.business.id, status: "active", approvedAt: new Date() },
      update: {},
    });
    const job = await harness.prisma.job.create({
      data: { businessId: harness.business.id, customerId: customer.id, riderId: rider.id, status: "delivered", paymentMethod: "cod", currency: "JMD", amountCollected: 40_000, codHandedInAmount: 40_000, codStatus: "approved" },
    });

    const before = await harness.app.inject({ method: "GET", url: `/api/riders/${rider.id}/cash`, headers: { authorization: `Bearer ${admin}` } });
    expect((before.json() as { businesses: { confirmed: { amount: { amount: number } } }[] }).businesses[0]!.confirmed.amount.amount).toBe(40_000);

    // Deletable: "delivered" isn't an active status, and "approved" COD
    // isn't outstanding — both of Stage 26's own guards allow this.
    const del = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` } });
    expect(del.statusCode).toBe(200);

    const after = await harness.app.inject({ method: "GET", url: `/api/riders/${rider.id}/cash`, headers: { authorization: `Bearer ${admin}` } });
    expect((after.json() as { businesses: { confirmed: { amount: { amount: number } } }[] }).businesses[0]!.confirmed.amount.amount).toBe(40_000);
  });
});

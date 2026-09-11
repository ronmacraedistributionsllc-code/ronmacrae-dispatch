/**
 * Deleted-orders trash (Stage 26 / spec 8): soft-delete only, ever — see
 * schema.prisma's own note on Job.deletedAt. Real Fastify app + real
 * sqlite db (see test/helpers/test-app.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let businessB: { id: string; name: string };
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function staffToken(businessId: string, role: "admin" | "dispatcher" | "accountant" | "viewer" = "dispatcher") {
  const user = await harness.prisma.user.create({ data: { name: `Trash ${uniq()}`, passwordHash: "unused-in-tests", role } });
  await harness.prisma.staffMembership.create({ data: { userId: user.id, businessId, role, active: true } });
  return harness.tokenFor({ id: user.id, name: user.name, role, businessId });
}

async function makeCustomer(businessId: string) {
  return harness.prisma.customer.create({ data: { businessId, name: "Trash Test Customer", phone: `+1876590${uniq()}` } });
}

async function makeJob(businessId: string, customerId: string, overrides: Record<string, unknown> = {}) {
  return harness.prisma.job.create({ data: { businessId, customerId, status: "new", ...overrides } });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-jobs-trash");
  businessB = await harness.prisma.business.create({ data: { name: "Trash Test Business B", slug: `trash-b-${Date.now()}` } });
});

afterAll(async () => {
  await harness.cleanup();
});

describe("deleting a job", () => {
  it("soft-deletes a terminal job: gone from the normal list and detail, still visible in trash", async () => {
    const admin = await staffToken(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    const job = await makeJob(harness.business.id, customer.id, { status: "delivered" });

    const del = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` }, payload: { reason: "duplicate order" } });
    expect(del.statusCode).toBe(200);

    const list = await harness.app.inject({ method: "GET", url: "/api/jobs?take=200", headers: { authorization: `Bearer ${admin}` } });
    expect((list.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id)).not.toContain(job.id);

    const detail = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: { authorization: `Bearer ${admin}` } });
    expect(detail.statusCode).toBe(404);

    const trash = await harness.app.inject({ method: "GET", url: "/api/jobs/trash", headers: { authorization: `Bearer ${admin}` } });
    const trashJobs = trash.json() as { jobs: { id: string; deleteReason: string | null; purged: boolean; daysRemaining: number }[] };
    const entry = trashJobs.jobs.find((j) => j.id === job.id);
    expect(entry).toBeTruthy();
    expect(entry!.deleteReason).toBe("duplicate order");
    expect(entry!.purged).toBe(false);
    expect(entry!.daysRemaining).toBe(30);

    const row = await harness.prisma.job.findUnique({ where: { id: job.id } });
    expect(row).toBeTruthy(); // the row itself was never actually removed
  });

  it("refuses to delete a job that's still actively out with a rider", async () => {
    const admin = await staffToken(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    const rider = await harness.prisma.rider.create({ data: { name: "Trash Active Rider", phone: `+1876591${uniq()}`, active: true, status: "available" } });
    const job = await makeJob(harness.business.id, customer.id, { status: "in_transit", riderId: rider.id });

    const del = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` } });
    expect(del.statusCode).toBe(409);

    const row = await harness.prisma.job.findUnique({ where: { id: job.id } });
    expect(row?.deletedAt).toBeNull();
  });

  it.each(["collected", "handed_in", "disputed"])("refuses to delete a job with unresolved COD (%s)", async (codStatus) => {
    const admin = await staffToken(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    const job = await makeJob(harness.business.id, customer.id, { status: "delivered", paymentMethod: "cod", codStatus });

    const del = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` } });
    expect(del.statusCode).toBe(409);
  });

  it("allows deleting a job whose COD is already approved (or never collected)", async () => {
    const admin = await staffToken(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    const approved = await makeJob(harness.business.id, customer.id, { status: "delivered", paymentMethod: "cod", codStatus: "approved" });
    const neverCollected = await makeJob(harness.business.id, customer.id, { status: "cancelled", paymentMethod: "cod" });

    const del1 = await harness.app.inject({ method: "POST", url: `/api/jobs/${approved.id}/delete`, headers: { authorization: `Bearer ${admin}` } });
    const del2 = await harness.app.inject({ method: "POST", url: `/api/jobs/${neverCollected.id}/delete`, headers: { authorization: `Bearer ${admin}` } });
    expect(del1.statusCode).toBe(200);
    expect(del2.statusCode).toBe(200);
  });

  it("refuses to delete an already-deleted job, and a non-admin/dispatcher can't delete at all", async () => {
    const admin = await staffToken(harness.business.id);
    const accountant = await staffToken(harness.business.id, "accountant");
    const customer = await makeCustomer(harness.business.id);
    const job = await makeJob(harness.business.id, customer.id, { status: "cancelled" });

    const forbidden = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${accountant}` } });
    expect(forbidden.statusCode).toBe(403);

    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` } });
    const again = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` } });
    expect(again.statusCode).toBe(409);
  });

  it("is audited", async () => {
    const admin = await staffToken(harness.business.id, "admin");
    const customer = await makeCustomer(harness.business.id);
    const job = await makeJob(harness.business.id, customer.id, { status: "cancelled" });
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` }, payload: { reason: "test audit" } });

    const audit = await harness.app.inject({ method: "GET", url: "/api/audit?take=500", headers: { authorization: `Bearer ${admin}` } });
    const entries = (audit.json() as { entries: { action: string; entityId: string | null; meta: Record<string, unknown> | null }[] }).entries;
    const entry = entries.find((e) => e.action === "job.delete" && e.entityId === job.id);
    expect(entry).toBeTruthy();
    expect(entry!.meta?.reason).toBe("test audit");
  });
});

describe("restoring a job", () => {
  it("brings a deleted job back to the normal list and detail, and out of the trash", async () => {
    const admin = await staffToken(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    const job = await makeJob(harness.business.id, customer.id, { status: "cancelled" });
    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` } });

    const restore = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/restore`, headers: { authorization: `Bearer ${admin}` } });
    expect(restore.statusCode).toBe(200);

    const detail = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: { authorization: `Bearer ${admin}` } });
    expect(detail.statusCode).toBe(200);

    const trash = await harness.app.inject({ method: "GET", url: "/api/jobs/trash", headers: { authorization: `Bearer ${admin}` } });
    expect((trash.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id)).not.toContain(job.id);
  });

  it("refuses to restore a job that isn't in the trash, and refuses past the 30-day window", async () => {
    const admin = await staffToken(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    const neverDeleted = await makeJob(harness.business.id, customer.id, { status: "cancelled" });
    const notInTrash = await harness.app.inject({ method: "POST", url: `/api/jobs/${neverDeleted.id}/restore`, headers: { authorization: `Bearer ${admin}` } });
    expect(notInTrash.statusCode).toBe(409);

    const longGone = await makeJob(harness.business.id, customer.id, { status: "cancelled" });
    await harness.prisma.job.update({ where: { id: longGone.id }, data: { deletedAt: new Date(Date.now() - 31 * 24 * 3600_000), deletedById: null } });
    const tooLate = await harness.app.inject({ method: "POST", url: `/api/jobs/${longGone.id}/restore`, headers: { authorization: `Bearer ${admin}` } });
    expect(tooLate.statusCode).toBe(410);

    // Still never actually deleted — the row (and its purge-eligibility
    // computed from deletedAt) is the whole point.
    const row = await harness.prisma.job.findUnique({ where: { id: longGone.id } });
    expect(row).toBeTruthy();
    const trash = await harness.app.inject({ method: "GET", url: "/api/jobs/trash", headers: { authorization: `Bearer ${admin}` } });
    const entry = (trash.json() as { jobs: { id: string; purged: boolean; daysRemaining: number }[] }).jobs.find((j) => j.id === longGone.id);
    expect(entry?.purged).toBe(true);
    expect(entry?.daysRemaining).toBe(0);
  });
});

describe("trash is business-scoped", () => {
  it("a business never sees another business's trashed jobs, and can't delete/restore them", async () => {
    const adminA = await staffToken(harness.business.id);
    const adminB = await staffToken(businessB.id);
    const customerA = await makeCustomer(harness.business.id);
    const jobA = await makeJob(harness.business.id, customerA.id, { status: "cancelled" });
    await harness.app.inject({ method: "POST", url: `/api/jobs/${jobA.id}/delete`, headers: { authorization: `Bearer ${adminA}` } });

    const trashFromB = await harness.app.inject({ method: "GET", url: "/api/jobs/trash", headers: { authorization: `Bearer ${adminB}` } });
    expect((trashFromB.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id)).not.toContain(jobA.id);

    const restoreFromB = await harness.app.inject({ method: "POST", url: `/api/jobs/${jobA.id}/restore`, headers: { authorization: `Bearer ${adminB}` } });
    expect(restoreFromB.statusCode).toBe(404);
  });
});

describe("preserved regardless of trash status", () => {
  it("a deleted job's cash-ledger and report data stay fully visible to accountants", async () => {
    const admin = await staffToken(harness.business.id);
    const accountant = await staffToken(harness.business.id, "accountant");
    const customer = await makeCustomer(harness.business.id);
    const job = await makeJob(harness.business.id, customer.id, { status: "delivered", paymentMethod: "cod", codStatus: "approved", amountCollected: 500000, jobNumber: `RM-TRASH-${uniq()}` });
    await harness.prisma.codEvent.create({ data: { jobId: job.id, from: "handed_in", to: "approved", actorType: "accountant", actorId: null, actorName: "Test" } });

    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` } });

    const codBoard = await harness.app.inject({ method: "GET", url: "/api/cod?take=200", headers: { authorization: `Bearer ${accountant}` } });
    expect((codBoard.json() as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toContain(job.id);

    const report = await harness.app.inject({ method: "GET", url: "/api/reports/summary", headers: { authorization: `Bearer ${accountant}` } });
    expect((report.json() as { rows: { jobId: string }[] }).rows.map((r) => r.jobId)).toContain(job.id);

    const codEvents = await harness.prisma.codEvent.findMany({ where: { jobId: job.id } });
    expect(codEvents.length).toBeGreaterThan(0); // never cascaded away
  });
});

describe("a trashed job closes messaging and tracking entirely", () => {
  it("the customer's tracking link 410s, and messaging 404s for staff/rider too", async () => {
    const admin = await staffToken(harness.business.id);
    const customer = await makeCustomer(harness.business.id);
    const job = await makeJob(harness.business.id, customer.id, { status: "cancelled" });
    const link = await harness.prisma.trackingLink.create({ data: { jobId: job.id, token: `trash-tok-${uniq()}`, expiresAt: new Date(Date.now() + 3600_000) } });

    await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/delete`, headers: { authorization: `Bearer ${admin}` } });

    const tracking = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}` });
    expect(tracking.statusCode).toBe(410);

    const customerMessages = await harness.app.inject({ method: "GET", url: `/api/tracking/${link.token}/messages/customer_dispatch` });
    expect(customerMessages.statusCode).toBe(410);

    const staffMessages = await harness.app.inject({ method: "GET", url: `/api/jobs/${job.id}/messages/customer_dispatch`, headers: { authorization: `Bearer ${admin}` } });
    expect(staffMessages.statusCode).toBe(404);
  });
});

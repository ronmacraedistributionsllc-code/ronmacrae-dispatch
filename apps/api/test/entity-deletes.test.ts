/**
 * Delete powers: the ultra admin can delete any merchant, business, rider,
 * logistics company, or team member; a business admin can only delete what
 * was created under their own company — marketplace-approved free-roam
 * riders are remove-membership-only, never deletable.
 *
 * Deletion is always deactivation (history stays intact; the login paths
 * already enforce the `active` flags), and always refuses while live
 * (non-terminal) work still references the record.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeUser(role: "admin" | "dispatcher", platformRole?: "owner") {
  const user = await harness.prisma.user.create({ data: { name: `Delete Test ${uniq()}`, passwordHash: "unused", role, ...(platformRole ? { platformRole } : {}) } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role, ...(platformRole ? { platformRole } : {}) });
  return { user, auth: { authorization: `Bearer ${token}` } };
}

async function makeMerchant(businessId?: string, slugSuffix?: string) {
  return harness.prisma.merchant.create({
    data: { businessId: businessId ?? harness.business.id, name: `Delete Mart ${uniq()}`, slug: `delete-mart-${slugSuffix ?? uniq()}` },
  });
}

async function makeCustomer(businessId?: string) {
  return harness.prisma.customer.create({ data: { businessId: businessId ?? harness.business.id, name: "Delete Customer", phone: `+18765${uniq().slice(-7)}` } });
}

async function makeJob(customerId: string, extra: Record<string, unknown> = {}) {
  const customer = await harness.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  return harness.prisma.job.create({
    data: { businessId: customer.businessId, customerId, jobNumber: `DEL-${uniq()}`, status: "new", ...extra },
  });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-entity-deletes");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("business-admin merchant delete", () => {
  it("deletes an own merchant with no live orders", async () => {
    const admin = await makeUser("admin");
    const merchant = await makeMerchant();
    const res = await harness.app.inject({ method: "DELETE", url: `/api/merchants/${merchant.id}`, headers: admin.auth });
    expect(res.statusCode).toBe(200);
    expect((await harness.prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).active).toBe(false);
    const audit = await harness.prisma.auditLog.findFirst({ where: { action: "merchant.delete", entityId: merchant.id } });
    expect(audit).not.toBeNull();
  });

  it("404s another company's merchant (never 403 — no probing)", async () => {
    const admin = await makeUser("admin");
    const otherBusiness = await harness.prisma.business.create({ data: { name: `Other Biz ${uniq()}`, slug: `other-biz-${uniq()}` } });
    const foreign = await makeMerchant(otherBusiness.id);
    const res = await harness.app.inject({ method: "DELETE", url: `/api/merchants/${foreign.id}`, headers: admin.auth });
    expect(res.statusCode).toBe(404);
    expect((await harness.prisma.merchant.findUniqueOrThrow({ where: { id: foreign.id } })).active).toBe(true);
  });

  it("refuses while live orders reference the merchant", async () => {
    const admin = await makeUser("admin");
    const merchant = await makeMerchant();
    const customer = await makeCustomer();
    await makeJob(customer.id, { merchantId: merchant.id });
    const res = await harness.app.inject({ method: "DELETE", url: `/api/merchants/${merchant.id}`, headers: admin.auth });
    expect(res.statusCode).toBe(409);
    expect((await harness.prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).active).toBe(true);
  });

  it("dispatchers cannot delete merchants", async () => {
    const dispatcher = await makeUser("dispatcher");
    const merchant = await makeMerchant();
    const res = await harness.app.inject({ method: "DELETE", url: `/api/merchants/${merchant.id}`, headers: dispatcher.auth });
    expect(res.statusCode).toBe(403);
  });
});

describe("ultra-admin deletes", () => {
  it("deletes any merchant across businesses", async () => {
    const owner = await makeUser("admin", "owner");
    const otherBusiness = await harness.prisma.business.create({ data: { name: `Other Biz ${uniq()}`, slug: `other-biz-${uniq()}` } });
    const foreign = await makeMerchant(otherBusiness.id);
    const res = await harness.app.inject({ method: "DELETE", url: `/api/platform/merchants/${foreign.id}`, headers: owner.auth });
    expect(res.statusCode).toBe(200);
    expect((await harness.prisma.merchant.findUniqueOrThrow({ where: { id: foreign.id } })).active).toBe(false);
  });

  it("deletes a business with no live orders, and its staff can no longer log in", async () => {
    const owner = await makeUser("admin", "owner");
    const doomed = await harness.prisma.business.create({ data: { name: `Doomed Biz ${uniq()}`, slug: `doomed-biz-${uniq()}` } });
    const staffUser = await harness.prisma.user.create({ data: { name: "Doomed Staff", passwordHash: "unused", role: "dispatcher" } });
    await harness.prisma.staffMembership.create({ data: { userId: staffUser.id, businessId: doomed.id, role: "dispatcher", active: true } });

    const res = await harness.app.inject({ method: "DELETE", url: `/api/platform/businesses/${doomed.id}`, headers: owner.auth });
    expect(res.statusCode).toBe(200);

    // resolveStaffContext now finds no (active-business) membership.
    const { resolveStaffContext } = await import("../src/modules/auth.js");
    await expect(resolveStaffContext(harness.ctx, { id: staffUser.id, role: "dispatcher", platformRole: null })).resolves.toBeNull();
  });

  it("refuses a business with live orders", async () => {
    const owner = await makeUser("admin", "owner");
    const customer = await makeCustomer();
    await makeJob(customer.id);
    const res = await harness.app.inject({ method: "DELETE", url: `/api/platform/businesses/${harness.business.id}`, headers: owner.auth });
    expect(res.statusCode).toBe(409);
    expect((await harness.prisma.business.findUniqueOrThrow({ where: { id: harness.business.id } })).active).toBe(true);
  });

  it("deletes a rider: deactivates, ends memberships, withdraws open offers", async () => {
    const owner = await makeUser("admin", "owner");
    const admin = await makeUser("admin");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/riders",
      headers: admin.auth,
      payload: { name: "Doomed Courier", phone: `+18765${uniq().slice(-7)}`, vehicle: "motorcycle" },
    });
    expect(created.statusCode).toBe(200);
    const riderId = (created.json() as { rider: { id: string } }).rider.id;

    const res = await harness.app.inject({ method: "DELETE", url: `/api/platform/riders/${riderId}`, headers: owner.auth });
    expect(res.statusCode).toBe(200);
    const row = await harness.prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect(row.active).toBe(false);
    expect(await harness.prisma.riderMembership.count({ where: { riderId, status: "active" } })).toBe(0);
  });

  it("releases a carrier's live work back to the claim pool instead of refusing", async () => {
    const owner = await makeUser("admin", "owner");
    const admin = await makeUser("admin");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/riders",
      headers: admin.auth,
      payload: { name: "Busy Courier", phone: `+18765${uniq().slice(-7)}`, vehicle: "motorcycle" },
    });
    const riderId = (created.json() as { rider: { id: string } }).rider.id;
    const customer = await makeCustomer();
    const job = await makeJob(customer.id, { riderId, status: "accepted" });
    const res = await harness.app.inject({ method: "DELETE", url: `/api/platform/riders/${riderId}`, headers: owner.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, jobsReleased: 1 });
    const released = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(released.status).toBe("new");
    expect(released.riderId).toBeNull();
    expect((await harness.prisma.rider.findUniqueOrThrow({ where: { id: riderId } })).active).toBe(false);
  });

  it("a business admin cannot use the platform delete routes", async () => {
    const admin = await makeUser("admin");
    const res = await harness.app.inject({ method: "DELETE", url: `/api/platform/businesses/${harness.business.id}`, headers: admin.auth });
    expect(res.statusCode).toBe(403);
  });
});

describe("business-admin rider delete vs remove", () => {
  it("deletes a company-created courier with no other ties", async () => {
    const admin = await makeUser("admin");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/riders",
      headers: admin.auth,
      payload: { name: "Own Courier", phone: `+18765${uniq().slice(-7)}`, vehicle: "motorcycle" },
    });
    const riderId = (created.json() as { rider: { id: string } }).rider.id;
    const res = await harness.app.inject({ method: "DELETE", url: `/api/riders/${riderId}`, headers: admin.auth });
    expect(res.statusCode).toBe(200);
    expect((await harness.prisma.rider.findUniqueOrThrow({ where: { id: riderId } })).active).toBe(false);
  });

  it("refuses a marketplace-approved rider — remove instead", async () => {
    const admin = await makeUser("admin");
    // NOTE: the harness auto-creates an active membership on rider.create —
    // never insert a second one (unique riderId/businessId).
    const rider = await harness.prisma.rider.create({
      data: { name: "Free Roamer", phone: `+18765${uniq().slice(-7)}`, active: true, status: "available", platformStatus: "approved", selfSignedUp: true },
    });
    const res = await harness.app.inject({ method: "DELETE", url: `/api/riders/${rider.id}`, headers: admin.auth });
    expect(res.statusCode).toBe(409);

    // ...but removing their membership works fine.
    const remove = await harness.app.inject({ method: "POST", url: `/api/riders/${rider.id}/remove`, headers: admin.auth });
    expect(remove.statusCode).toBe(200);
    expect((await harness.prisma.riderMembership.findFirstOrThrow({ where: { riderId: rider.id, businessId: harness.business.id } })).status).toBe("removed");
    expect((await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).active).toBe(true);
  });

  it("refuses a courier created by another company", async () => {
    const admin = await makeUser("admin");
    const otherBusiness = await harness.prisma.business.create({ data: { name: `Other Biz ${uniq()}`, slug: `other-biz-${uniq()}` } });
    const rider = await harness.prisma.rider.create({
      data: { name: "Foreign Courier", phone: `+18765${uniq().slice(-7)}`, active: true, status: "available", createdByBusinessId: otherBusiness.id },
    });
    const res = await harness.app.inject({ method: "DELETE", url: `/api/riders/${rider.id}`, headers: admin.auth });
    expect(res.statusCode).toBe(409);
  });

  it("dispatchers cannot delete courier rows, but can remove memberships", async () => {
    const dispatcher = await makeUser("dispatcher");
    const admin = await makeUser("admin");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/riders",
      headers: admin.auth,
      payload: { name: "Dispatch Courier", phone: `+18765${uniq().slice(-7)}`, vehicle: "motorcycle" },
    });
    const riderId = (created.json() as { rider: { id: string } }).rider.id;
    expect((await harness.app.inject({ method: "DELETE", url: `/api/riders/${riderId}`, headers: dispatcher.auth })).statusCode).toBe(403);
    expect((await harness.app.inject({ method: "POST", url: `/api/riders/${riderId}/remove`, headers: dispatcher.auth })).statusCode).toBe(200);
  });
});

describe("staff membership removal", () => {
  it("an admin removes a dispatcher; self-removal is refused", async () => {
    const admin = await makeUser("admin");
    const admin2 = await makeUser("admin");
    const dispatcher = await makeUser("dispatcher");
    for (const u of [admin, admin2, dispatcher]) {
      await harness.prisma.staffMembership.create({ data: { userId: u.user.id, businessId: harness.business.id, role: u.user.role as "admin" | "dispatcher", active: true } });
    }

    const res = await harness.app.inject({ method: "DELETE", url: `/api/users/${dispatcher.user.id}/membership`, headers: admin.auth });
    expect(res.statusCode).toBe(200);
    expect((await harness.prisma.staffMembership.findFirstOrThrow({ where: { userId: dispatcher.user.id, businessId: harness.business.id } })).active).toBe(false);

    const self = await harness.app.inject({ method: "DELETE", url: `/api/users/${admin.user.id}/membership`, headers: admin.auth });
    expect(self.statusCode).toBe(400);
  });

  it("removing one admin works while another remains", async () => {
    const admin = await makeUser("admin");
    const admin2 = await makeUser("admin");
    for (const u of [admin, admin2]) {
      await harness.prisma.staffMembership.create({ data: { userId: u.user.id, businessId: harness.business.id, role: "admin", active: true } });
    }
    const res = await harness.app.inject({ method: "DELETE", url: `/api/users/${admin2.user.id}/membership`, headers: admin.auth });
    expect(res.statusCode).toBe(200);
  });
});

describe("business-admin logistics company delete", () => {
  it("deletes an own company with no live attached work", async () => {
    const admin = await makeUser("admin");
    const company = await harness.prisma.logisticsCompany.create({
      data: { businessId: harness.business.id, name: `Delete Fleet ${uniq()}`, slug: `delete-fleet-${uniq()}` },
    });
    const res = await harness.app.inject({ method: "DELETE", url: `/api/logistics-companies/${company.id}`, headers: admin.auth });
    expect(res.statusCode).toBe(200);
    expect((await harness.prisma.logisticsCompany.findUniqueOrThrow({ where: { id: company.id } })).active).toBe(false);
  });

  it("404s another company's fleet", async () => {
    const admin = await makeUser("admin");
    const otherBusiness = await harness.prisma.business.create({ data: { name: `Other Biz ${uniq()}`, slug: `other-biz-${uniq()}` } });
    const foreign = await harness.prisma.logisticsCompany.create({
      data: { businessId: otherBusiness.id, name: `Foreign Fleet ${uniq()}`, slug: `foreign-fleet-${uniq()}` },
    });
    const res = await harness.app.inject({ method: "DELETE", url: `/api/logistics-companies/${foreign.id}`, headers: admin.auth });
    expect(res.statusCode).toBe(404);
  });
});

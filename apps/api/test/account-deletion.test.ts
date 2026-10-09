/**
 * Self-service account deletion (store-review requirement). Covers the
 * rules the feature's own doc comment promises: password re-auth, history
 * preserved, every login face refuses afterward, and the refusals that stop
 * a deletion from stranding something real (sole admin, platform owner,
 * work in progress, unreconciled cash, impersonation).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { hashPassword } from "../src/lib/password.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;
const PASSWORD = "deleteMe-12345";

beforeAll(async () => {
  harness = await buildTestHarness("test-account-deletion");
});
afterAll(async () => {
  await harness.cleanup();
});

async function makeBusiness() {
  return harness.prisma.business.create({ data: { name: `Biz ${uniq()}`, slug: `biz-${uniq()}` } });
}

async function makeStaff(role: "admin" | "dispatcher", businessId: string) {
  const user = await harness.prisma.user.create({
    data: { name: `Staff ${uniq()}`, email: `staff-${uniq()}@example.com`, passwordHash: hashPassword(PASSWORD), role },
  });
  await harness.prisma.staffMembership.create({ data: { userId: user.id, businessId, role, active: true } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role, businessId });
  return { user, token };
}

async function makeCourier() {
  const user = await harness.prisma.user.create({
    data: { name: `Courier ${uniq()}`, email: `courier-${uniq()}@example.com`, passwordHash: hashPassword(PASSWORD), role: "rider" },
  });
  const rider = await harness.prisma.rider.create({ data: { name: user.name, phone: `+1876544${uniq().slice(-6)}`, active: true, status: "available", userId: user.id } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { user, rider, token };
}

const del = (token: string, password: string) =>
  harness.app.inject({ method: "POST", url: "/api/auth/delete-account", headers: { authorization: `Bearer ${token}` }, payload: { password } });

async function makeCustomerAndJob(riderId: string, extra: Record<string, unknown> = {}) {
  const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Del Test Customer", phone: `+1876533${uniq().slice(-6)}` } });
  return harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, riderId, status: "delivered", ...extra } });
}

describe("account deletion — a courier", () => {
  it("deletes with the right password: login refused on every path, access flags off, history untouched", async () => {
    const { user, rider, token } = await makeCourier();
    const job = await makeCustomerAndJob(rider.id);
    await harness.prisma.pushSubscription.create({ data: { userId: user.id, endpoint: `https://push.example/${uniq()}`, p256dh: "p", auth: "a" } });

    const res = await del(token, PASSWORD);
    expect(res.statusCode).toBe(200);

    const row = await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.active).toBe(false);

    // Can no longer be offered work.
    const riderRow = await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(riderRow.active).toBe(false);
    expect(riderRow.status).toBe("offline");

    // Reachable/actionable surfaces are gone.
    expect(await harness.prisma.pushSubscription.count({ where: { userId: user.id } })).toBe(0);
    expect(await harness.prisma.session.count({ where: { userId: user.id } })).toBe(0);

    // The unified login now refuses, distinctly from a plain wrong password.
    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: user.email, password: PASSWORD } });
    expect(login.statusCode).toBe(403);
    expect((login.json() as { error: { message: string } }).error.message).toBe("Account deleted");

    // History is exactly as it was — the job still names this courier.
    const jobRow = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobRow.riderId).toBe(rider.id);

    // Audited, with no credential material.
    const audit = await harness.prisma.auditLog.findFirst({ where: { action: "account.self_delete", entityId: user.id } });
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it("a wrong password changes nothing", async () => {
    const { user, token } = await makeCourier();
    const res = await del(token, "not-the-password");
    expect(res.statusCode).toBe(403);
    const row = await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.active).toBe(true);
  });

  it("refuses while a delivery is in progress", async () => {
    const { user, rider, token } = await makeCourier();
    await makeCustomerAndJob(rider.id, { status: "in_transit" });
    const res = await del(token, PASSWORD);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/delivery in progress/i);
    expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).toBeNull();
  });

  it("refuses while cash-on-delivery is held or unreconciled", async () => {
    const { user, rider, token } = await makeCourier();
    await makeCustomerAndJob(rider.id, { paymentMethod: "cod", codStatus: "handed_in", amountCollected: 1000, amountExpected: 1000 });
    const res = await del(token, PASSWORD);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/cash-on-delivery/i);
    expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).toBeNull();
  });

  it("a second delete of the same account is refused, not silently repeated", async () => {
    const { token } = await makeCourier();
    expect((await del(token, PASSWORD)).statusCode).toBe(200);
    expect((await del(token, PASSWORD)).statusCode).toBe(409);
  });
});

describe("account deletion — staff and owners", () => {
  it("the only admin of a business can't delete (never orphan a business) — but can once another admin exists", async () => {
    const biz = await makeBusiness();
    const sole = await makeStaff("admin", biz.id);

    const refused = await del(sole.token, PASSWORD);
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { message: string } }).error.message).toContain(biz.name);
    expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: sole.user.id } })).deletedAt).toBeNull();

    await makeStaff("admin", biz.id);
    const ok = await del(sole.token, PASSWORD);
    expect(ok.statusCode).toBe(200);
    // Membership row kept (history), access flag off.
    const m = await harness.prisma.staffMembership.findFirstOrThrow({ where: { userId: sole.user.id } });
    expect(m.active).toBe(false);
  });

  it("a dispatcher (not an admin) deletes freely", async () => {
    const biz = await makeBusiness();
    const d = await makeStaff("dispatcher", biz.id);
    expect((await del(d.token, PASSWORD)).statusCode).toBe(200);
  });

  it("a platform owner can't self-delete", async () => {
    const owner = await harness.prisma.user.create({
      data: { name: "Owner", email: `owner-${uniq()}@example.com`, passwordHash: hashPassword(PASSWORD), role: "admin", platformRole: "owner" },
    });
    const token = await harness.tokenFor({ id: owner.id, name: owner.name, role: "admin", platformRole: "owner" });
    const res = await del(token, PASSWORD);
    expect(res.statusCode).toBe(409);
    expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).deletedAt).toBeNull();
  });

  it("an admin impersonating someone can never delete that person's account", async () => {
    const biz = await makeBusiness();
    const target = await makeStaff("dispatcher", biz.id);
    const adminId = (await makeStaff("admin", biz.id)).user.id;
    const impersonationToken = await harness.ctx.jwt.issueAccess({
      id: target.user.id, name: target.user.name, role: "dispatcher", businessId: biz.id, impersonatedBy: adminId,
    });
    const res = await del(impersonationToken, PASSWORD);
    expect(res.statusCode).toBe(403);
    expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).deletedAt).toBeNull();
  });

  it("an unauthenticated request is refused outright", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/api/auth/delete-account", payload: { password: PASSWORD } });
    expect(res.statusCode).toBe(401);
  });
});

describe("account deletion — the other login faces", () => {
  it("a merchant-portal person deletes through their own portal token, and the portal login then refuses", async () => {
    const biz = await makeBusiness();
    const merchant = await harness.prisma.merchant.create({ data: { businessId: biz.id, name: `Del Merchant ${uniq()}`, slug: `del-merchant-${uniq()}` } });
    const user = await harness.prisma.user.create({
      data: { name: "Merchant Person", email: `merchant-${uniq()}@example.com`, passwordHash: hashPassword(PASSWORD), role: "viewer" },
    });
    await harness.prisma.merchantStaff.create({ data: { userId: user.id, merchantId: merchant.id, active: true } });
    const token = await harness.ctx.jwt.issueMerchantPortal(user.id, merchant.id);

    const wrong = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/delete-account", headers: { authorization: `Bearer ${token}` }, payload: { password: "nope" } });
    expect(wrong.statusCode).toBe(403);

    const ok = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/delete-account", headers: { authorization: `Bearer ${token}` }, payload: { password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    expect((await harness.prisma.merchantStaff.findFirstOrThrow({ where: { userId: user.id } })).active).toBe(false);

    const login = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email: user.email, password: PASSWORD } });
    expect(login.statusCode).toBe(401);
  });

  it("a staff access token can't be used on the merchant-portal deletion route", async () => {
    const biz = await makeBusiness();
    const d = await makeStaff("dispatcher", biz.id);
    const res = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/delete-account", headers: { authorization: `Bearer ${d.token}` }, payload: { password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: d.user.id } })).deletedAt).toBeNull();
  });

  it("a logistics-portal person deletes through their own portal token", async () => {
    const biz = await makeBusiness();
    const company = await harness.prisma.logisticsCompany.create({ data: { businessId: biz.id, name: `Del Fleet ${uniq()}`, slug: `del-fleet-${uniq()}` } });
    const user = await harness.prisma.user.create({
      data: { name: "Fleet Person", email: `fleet-${uniq()}@example.com`, passwordHash: hashPassword(PASSWORD), role: "viewer" },
    });
    await harness.prisma.logisticsCompanyStaff.create({ data: { userId: user.id, logisticsCompanyId: company.id, active: true } });
    const token = await harness.ctx.jwt.issueLogisticsPortal(user.id, company.id);
    const res = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/delete-account", headers: { authorization: `Bearer ${token}` }, payload: { password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).not.toBeNull();
  });

  it("a customer deletes their email+password account; their orders stay with the business", async () => {
    const phone = `+1876522${uniq().slice(-6)}`;
    const identity = await harness.prisma.customerIdentity.create({ data: { normalizedPhone: phone, normalizedEmail: `cust-${uniq()}@example.com`, status: "verified" } });
    await harness.prisma.customerAccount.create({ data: { identityId: identity.id, email: identity.normalizedEmail!, passwordHash: hashPassword(PASSWORD), emailVerifiedAt: new Date() } });
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Cust", phone, identityId: identity.id } });
    const job = await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, status: "delivered" } });
    const token = await harness.ctx.jwt.issueCustomerDashboard(phone);

    const wrong = await harness.app.inject({ method: "POST", url: "/api/customer-account/delete", headers: { authorization: `Bearer ${token}` }, payload: { password: "nope" } });
    expect(wrong.statusCode).toBe(403);

    const ok = await harness.app.inject({ method: "POST", url: "/api/customer-account/delete", headers: { authorization: `Bearer ${token}` }, payload: { password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    expect(await harness.prisma.customerAccount.count({ where: { identityId: identity.id } })).toBe(0);
    expect((await harness.prisma.customerIdentity.findUniqueOrThrow({ where: { id: identity.id } })).normalizedEmail).toBeNull();
    // The delivery record belongs to the business and is untouched.
    expect(await harness.prisma.job.count({ where: { id: job.id } })).toBe(1);

    // And it's gone for real: nothing left to delete.
    const again = await harness.app.inject({ method: "POST", url: "/api/customer-account/delete", headers: { authorization: `Bearer ${token}` }, payload: { password: PASSWORD } });
    expect(again.statusCode).toBe(404);
  });
});

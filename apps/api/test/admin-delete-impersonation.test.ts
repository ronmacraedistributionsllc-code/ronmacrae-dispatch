/**
 * Master admin global delete (spec: "MASTER ADMIN MUST BE ABLE TO DELETE
 * ANY ACCOUNT FROM THE PLATFORM") and admin impersonation ("Login As",
 * without knowing or changing the target's password). Both live on the
 * shared User row, so one route pair covers every account type the spec
 * names — merchant staff, courier, logistics staff, dispatcher — not a
 * separate mechanism per type.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function ownerToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Owner ${uniq()}`, passwordHash: "unused-in-tests", role: "admin", platformRole: "owner" } });
  const token = await h.tokenFor({ id: user.id, name: user.name, role: "admin", platformRole: "owner" });
  return { token, userId: user.id };
}

async function makeMerchant(h: TestHarness, auth: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/merchants",
    headers: { authorization: `Bearer ${auth}` },
    payload: { name: `VBR Basics ${uniq()}`, notificationEmails: "owner@vbr.example" },
  });
  return (res.json() as { merchant: { id: string } }).merchant;
}

async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: h.business.id });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-admin-delete-impersonation");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("master admin global delete", () => {
  it("a deleted account can never log in again — through the unified login, distinctly from a merely-disabled one", async () => {
    const { token: owner } = await ownerToken(harness);
    const email = `delete-me-${uniq()}@example.com`;
    const password = "deleteme123";
    const user = await harness.prisma.user.create({ data: { name: "Delete Me", email, role: "viewer", passwordHash: hashPassword(password), active: true } });

    const loginBefore = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password } });
    expect(loginBefore.statusCode).not.toBe(401); // real account, real password — never "Invalid credentials"

    const del = await harness.app.inject({ method: "DELETE", url: `/api/platform/users/${user.id}`, headers: { authorization: `Bearer ${owner}` } });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deletedAt: string }).deletedAt).toBeTruthy();

    const row = await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.active).toBe(false);

    const loginAfter = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password } });
    expect(loginAfter.statusCode).toBe(403);
    expect((loginAfter.json() as { error: { message: string } }).error.message).toBe("Account deleted");

    // Distinct from a plain disable: a merely-suspended account gets a
    // different message, and — critically — once deleted, disable/
    // reactivate itself is refused (there's no "un-delete via disable toggle").
    const redisable = await harness.app.inject({ method: "PATCH", url: `/api/platform/users/${user.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { active: true } });
    expect(redisable.statusCode).toBe(409);
  });

  it("blocks login through EVERY face the account can reach, not just the unified route — a deleted admin who also holds merchant-staff access can't slip in through merchant-portal login", async () => {
    const { token: owner } = await ownerToken(harness);
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const email = `multi-face-${uniq()}@example.com`;
    const password = "multiface123";
    await harness.app.inject({ method: "POST", url: `/api/merchants/${merchant.id}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email, password } });
    const user = await harness.prisma.user.findUniqueOrThrow({ where: { email } });

    const merchantLoginBefore = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email, password } });
    expect(merchantLoginBefore.statusCode).toBe(200);

    await harness.app.inject({ method: "DELETE", url: `/api/platform/users/${user.id}`, headers: { authorization: `Bearer ${owner}` } });

    const merchantLoginAfter = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email, password } });
    expect(merchantLoginAfter.statusCode).toBe(401); // merchant-portal's own generic message, same as a wrong password — deliberately no enumeration signal
  });

  it("historical records survive a courier's account deletion — the job keeps its rider identity, ratings and audit log stay intact", async () => {
    const { token: owner } = await ownerToken(harness);
    const password = "courierdeleted1";
    const email = `deleted-courier-${uniq()}@example.com`;
    const rider = await harness.prisma.rider.create({
      data: {
        name: "Deleted Courier",
        phone: `+1876555${uniq().slice(-4)}`,
        vehicle: "motorcycle",
        status: "available",
        user: { create: { email, name: "Deleted Courier", role: "rider", passwordHash: hashPassword(password) } },
      },
      include: { user: true },
    });
    const customer = await harness.prisma.customer.create({
      data: { businessId: harness.business.id, name: "Cust", phone: `+1876555${uniq().slice(-4)}` },
    });
    const job = await harness.prisma.job.create({
      data: {
        businessId: harness.business.id,
        riderId: rider.id,
        customerId: customer.id,
        itemSummary: "Test parcel",
        status: "delivered",
      },
    });

    const del = await harness.app.inject({ method: "DELETE", url: `/api/platform/users/${rider.userId}`, headers: { authorization: `Bearer ${owner}` } });
    expect(del.statusCode).toBe(200);

    // Job row is completely untouched — same rider, same everything.
    const jobRow = await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobRow.riderId).toBe(rider.id);
    // The rider profile itself is untouched too — only the login account is gone.
    const riderRow = await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(riderRow.name).toBe("Deleted Courier");
    // The delete itself is a real, queryable audit record.
    const auditRow = await harness.prisma.auditLog.findFirst({ where: { action: "platform.user.delete", entityId: rider.userId! } });
    expect(auditRow).toBeTruthy();

    // And they genuinely can't log in anymore.
    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password } });
    expect(login.statusCode).toBe(403);
  });

  it("cannot delete your own account, and cannot delete an account twice", async () => {
    const { token: owner, userId: ownerId } = await ownerToken(harness);
    const selfDelete = await harness.app.inject({ method: "DELETE", url: `/api/platform/users/${ownerId}`, headers: { authorization: `Bearer ${owner}` } });
    expect(selfDelete.statusCode).toBe(400);

    const target = await harness.prisma.user.create({ data: { name: "Twice", email: `twice-${uniq()}@example.com`, role: "viewer", passwordHash: "unused-in-tests" } });
    const first = await harness.app.inject({ method: "DELETE", url: `/api/platform/users/${target.id}`, headers: { authorization: `Bearer ${owner}` } });
    expect(first.statusCode).toBe(200);
    const second = await harness.app.inject({ method: "DELETE", url: `/api/platform/users/${target.id}`, headers: { authorization: `Bearer ${owner}` } });
    expect(second.statusCode).toBe(409);
  });

  it("a non-owner is refused entirely", async () => {
    const admin = await adminToken(harness);
    const target = await harness.prisma.user.create({ data: { name: "Target", email: `nonowner-target-${uniq()}@example.com`, role: "viewer", passwordHash: "unused-in-tests" } });
    const res = await harness.app.inject({ method: "DELETE", url: `/api/platform/users/${target.id}`, headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(403);
  });
});

describe("admin impersonation", () => {
  it("issues a working session for the target account, never exposes or changes their password, and is fully audited both ways", async () => {
    const { token: owner, userId: ownerId } = await ownerToken(harness);
    const password = "targetpass123";
    const passwordHash = hashPassword(password);
    const target = await harness.prisma.user.create({ data: { name: "Target VBR", email: `impersonate-target-${uniq()}@example.com`, role: "dispatcher", passwordHash, active: true } });
    await harness.prisma.staffMembership.create({ data: { userId: target.id, businessId: harness.business.id, role: "dispatcher", active: true } });

    const start = await harness.app.inject({ method: "POST", url: `/api/platform/users/${target.id}/impersonate`, headers: { authorization: `Bearer ${owner}` } });
    expect(start.statusCode).toBe(200);
    const body = start.json() as { accessToken: string; user: { id: string; name: string } };
    expect(body.user.id).toBe(target.id);
    // The response never contains anything resembling the password/hash.
    expect(JSON.stringify(body)).not.toContain(passwordHash);
    expect(JSON.stringify(body)).not.toContain(password);

    // The issued token genuinely authorizes as the target — a real staff-guarded route works.
    const jobsList = await harness.app.inject({ method: "GET", url: "/api/jobs", headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(jobsList.statusCode).toBe(200);

    // /api/auth/me reports who's really behind the wheel.
    const me = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${body.accessToken}` } });
    const meBody = me.json() as { user: { id: string }; impersonatedBy: { id: string } | null };
    expect(meBody.user.id).toBe(target.id);
    expect(meBody.impersonatedBy?.id).toBe(ownerId);

    // Started, audited with both identities.
    const startAudit = await harness.prisma.auditLog.findFirst({ where: { action: "platform.impersonation.start", entityId: target.id } });
    expect(startAudit?.userId).toBe(ownerId);

    // Ending it is audited too, and requires an actual impersonation token.
    const end = await harness.app.inject({ method: "POST", url: "/api/platform/impersonation/end", headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(end.statusCode).toBe(200);
    const endAudit = await harness.prisma.auditLog.findFirst({ where: { action: "platform.impersonation.end", entityId: target.id } });
    expect(endAudit?.userId).toBe(ownerId);

    // The target's own password was never touched by any of this.
    const targetRow = await harness.prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(verifyPassword(password, targetRow.passwordHash)).toBe(true);
    const targetLogin = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: target.email, password } });
    expect(targetLogin.statusCode).toBe(200);
  });

  it("ending impersonation is refused on an ordinary (non-impersonation) session — there's nothing to end", async () => {
    const { token: owner } = await ownerToken(harness);
    const res = await harness.app.inject({ method: "POST", url: "/api/platform/impersonation/end", headers: { authorization: `Bearer ${owner}` } });
    expect(res.statusCode).toBe(400);
  });

  it("cannot impersonate yourself, a deleted account, or a disabled account", async () => {
    const { token: owner, userId: ownerId } = await ownerToken(harness);
    const self = await harness.app.inject({ method: "POST", url: `/api/platform/users/${ownerId}/impersonate`, headers: { authorization: `Bearer ${owner}` } });
    expect(self.statusCode).toBe(400);

    const deleted = await harness.prisma.user.create({ data: { name: "Deleted Target", email: `deleted-target-${uniq()}@example.com`, role: "viewer", passwordHash: "unused-in-tests", deletedAt: new Date(), active: false } });
    const impersonateDeleted = await harness.app.inject({ method: "POST", url: `/api/platform/users/${deleted.id}/impersonate`, headers: { authorization: `Bearer ${owner}` } });
    expect(impersonateDeleted.statusCode).toBe(409);

    const disabled = await harness.prisma.user.create({ data: { name: "Disabled Target", email: `disabled-target-${uniq()}@example.com`, role: "viewer", passwordHash: "unused-in-tests", active: false } });
    const impersonateDisabled = await harness.app.inject({ method: "POST", url: `/api/platform/users/${disabled.id}/impersonate`, headers: { authorization: `Bearer ${owner}` } });
    expect(impersonateDisabled.statusCode).toBe(409);
  });

  it("a non-owner cannot impersonate anyone", async () => {
    const admin = await adminToken(harness);
    const target = await harness.prisma.user.create({ data: { name: "Target", email: `nonowner-impersonate-${uniq()}@example.com`, role: "viewer", passwordHash: "unused-in-tests" } });
    const res = await harness.app.inject({ method: "POST", url: `/api/platform/users/${target.id}/impersonate`, headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(403);
  });
});

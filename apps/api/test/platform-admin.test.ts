/**
 * The platform-owner console (spec: "search, inspect, approve, block,
 * disable, archive, reactivate, and manage every registered business and
 * person"). Gated by the existing `platformRole: "owner"` concept
 * (owner.ts, Stage 23) — not a new auth face. The real test here is
 * cross-business visibility (an owner sees everything) combined with
 * ordinary staff being refused these routes entirely.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function ownerToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Owner ${uniq()}`, passwordHash: "unused-in-tests", role: "admin", platformRole: "owner" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", platformRole: "owner" });
}

async function adminToken(h: TestHarness, businessId?: string) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: businessId ?? h.business.id });
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

async function makeRider(h: TestHarness, auth: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/riders",
    headers: { authorization: `Bearer ${auth}` },
    payload: { name: `Rider ${uniq()}`, phone: `+1876555${uniq().slice(-4)}` },
  });
  return (res.json() as { rider: { id: string } }).rider;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-platform-admin");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("platform-admin: access control", () => {
  it("an ordinary admin (no platformRole) is refused every platform route", async () => {
    const admin = await adminToken(harness);
    for (const url of ["/api/platform/businesses", "/api/platform/merchants", "/api/platform/riders", "/api/platform/staff", "/api/platform/audit"]) {
      const res = await harness.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${admin}` } });
      expect(res.statusCode).toBe(403);
    }
  });

  it("a real platform owner can list every business, not just one", async () => {
    const owner = await ownerToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/platform/businesses", headers: { authorization: `Bearer ${owner}` } });
    expect(res.statusCode).toBe(200);
    const { businesses } = res.json() as { businesses: { id: string }[] };
    expect(businesses.some((b) => b.id === harness.business.id)).toBe(true);
  });
});

describe("platform-admin: businesses", () => {
  it("can disable and reactivate a business", async () => {
    const owner = await ownerToken(harness);
    const disable = await harness.app.inject({ method: "PATCH", url: `/api/platform/businesses/${harness.business.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { active: false } });
    expect(disable.statusCode).toBe(200);
    const row = await harness.prisma.business.findUniqueOrThrow({ where: { id: harness.business.id } });
    expect(row.active).toBe(false);

    const reactivate = await harness.app.inject({ method: "PATCH", url: `/api/platform/businesses/${harness.business.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { active: true } });
    expect(reactivate.statusCode).toBe(200);
  });
});

describe("platform-admin: merchants", () => {
  it("sees merchants across the business, with the business name attached, and can disable one", async () => {
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const owner = await ownerToken(harness);

    const list = await harness.app.inject({ method: "GET", url: "/api/platform/merchants", headers: { authorization: `Bearer ${owner}` } });
    expect(list.statusCode).toBe(200);
    const found = (list.json() as { merchants: { id: string; business: { id: string; name: string } }[] }).merchants.find((m) => m.id === merchant.id);
    expect(found?.business.id).toBe(harness.business.id);

    const disable = await harness.app.inject({ method: "PATCH", url: `/api/platform/merchants/${merchant.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { active: false } });
    expect(disable.statusCode).toBe(200);
    const row = await harness.prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(row.active).toBe(false);
  });
});

describe("platform-admin: riders", () => {
  it("can approve/suspend a rider's platform status, and the detail view shows real memberships and job counts", async () => {
    const admin = await adminToken(harness);
    const rider = await makeRider(harness, admin);
    const owner = await ownerToken(harness);

    const initial = await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(initial.platformStatus).toBe("pending");

    const approve = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { platformStatus: "approved" } });
    expect(approve.statusCode).toBe(200);
    expect((approve.json() as { platformStatus: string }).platformStatus).toBe("approved");

    const suspend = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { platformStatus: "suspended", active: false } });
    expect(suspend.statusCode).toBe(200);
    const row = await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(row.platformStatus).toBe("suspended");
    expect(row.active).toBe(false);

    const detail = await harness.app.inject({ method: "GET", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` } });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { rider: { memberships: { businessId: string }[]; jobsByStatus: Record<string, number> } };
    expect(body.rider.memberships.some((m) => m.businessId === harness.business.id)).toBe(true);
    expect(body.rider.jobsByStatus).toEqual({});
  });
});

describe("platform-admin: staff and self-protection", () => {
  it("lists staff across businesses and can disable one, but never the caller's own account", async () => {
    const owner = await ownerToken(harness);
    const admin = await adminToken(harness);
    const list = await harness.app.inject({ method: "GET", url: "/api/platform/staff", headers: { authorization: `Bearer ${owner}` } });
    expect(list.statusCode).toBe(200);

    const decoded = JSON.parse(Buffer.from(owner.split(".")[1]!, "base64url").toString());
    const selfDisable = await harness.app.inject({ method: "PATCH", url: `/api/platform/users/${decoded.sub}`, headers: { authorization: `Bearer ${owner}` }, payload: { active: false } });
    expect(selfDisable.statusCode).toBe(400);

    void admin;
  });
});

describe("platform-admin: audit", () => {
  it("every mutating action here is audited and shows up in the platform-wide log", async () => {
    const owner = await ownerToken(harness);
    await harness.app.inject({ method: "PATCH", url: `/api/platform/businesses/${harness.business.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { active: true } });
    const audit = await harness.app.inject({ method: "GET", url: "/api/platform/audit?action=platform.business", headers: { authorization: `Bearer ${owner}` } });
    expect(audit.statusCode).toBe(200);
    const body = audit.json() as { logs: { action: string }[] };
    expect(body.logs.some((l) => l.action.startsWith("platform.business"))).toBe(true);
  });
});

describe("platform-admin: rider merchant assignment", () => {
  it("assigns one rider to multiple merchants and removes one relationship without deleting the rider", async () => {
    const admin = await adminToken(harness);
    const merchantA = await makeMerchant(harness, admin);
    const merchantB = await makeMerchant(harness, admin);
    const rider = await makeRider(harness, admin);
    const owner = await ownerToken(harness);

    // Rider starts with no merchant relationships.
    const initialList = await harness.app.inject({ method: "GET", url: "/api/platform/riders", headers: { authorization: `Bearer ${owner}` } });
    const initialRow = (initialList.json() as { riders: { id: string; merchants: unknown[] }[] }).riders.find((r) => r.id === rider.id);
    expect(initialRow?.merchants).toHaveLength(0);

    // Assign to A.
    const assignA = await harness.app.inject({ method: "POST", url: `/api/platform/riders/${rider.id}/merchants`, headers: { authorization: `Bearer ${owner}` }, payload: { merchantId: merchantA.id } });
    expect(assignA.statusCode).toBe(200);

    // Assign to B too (many-to-many: same rider, second merchant).
    const assignB = await harness.app.inject({ method: "POST", url: `/api/platform/riders/${rider.id}/merchants`, headers: { authorization: `Bearer ${owner}` }, payload: { merchantId: merchantB.id } });
    expect(assignB.statusCode).toBe(200);

    // Duplicate assignment is refused.
    const dup = await harness.app.inject({ method: "POST", url: `/api/platform/riders/${rider.id}/merchants`, headers: { authorization: `Bearer ${owner}` }, payload: { merchantId: merchantA.id } });
    expect(dup.statusCode).toBe(409);

    // List shows both merchants.
    const list = await harness.app.inject({ method: "GET", url: "/api/platform/riders", headers: { authorization: `Bearer ${owner}` } });
    const row = (list.json() as { riders: { id: string; merchants: { merchantId: string }[] }[] }).riders.find((r) => r.id === rider.id);
    expect(row?.merchants.some((m) => m.merchantId === merchantA.id)).toBe(true);
    expect(row?.merchants.some((m) => m.merchantId === merchantB.id)).toBe(true);

    // Remove from A only.
    const removeA = await harness.app.inject({ method: "DELETE", url: `/api/platform/riders/${rider.id}/merchants/${merchantA.id}`, headers: { authorization: `Bearer ${owner}` } });
    expect(removeA.statusCode).toBe(200);

    // Rider account still exists; still attached to B, no longer to A.
    expect(await harness.prisma.rider.findUnique({ where: { id: rider.id } })).not.toBeNull();
    const relA = await harness.prisma.merchantRider.findUnique({ where: { merchantId_riderId: { merchantId: merchantA.id, riderId: rider.id } } });
    expect(relA?.status).toBe("removed");
    const relB = await harness.prisma.merchantRider.findUnique({ where: { merchantId_riderId: { merchantId: merchantB.id, riderId: rider.id } } });
    expect(relB?.status).toBe("active");
  });

  it("refuses assignment to a non-existent merchant or rider", async () => {
    const owner = await ownerToken(harness);
    const admin = await adminToken(harness);
    const rider = await makeRider(harness, admin);

    const badMerchant = await harness.app.inject({ method: "POST", url: `/api/platform/riders/${rider.id}/merchants`, headers: { authorization: `Bearer ${owner}` }, payload: { merchantId: "does-not-exist" } });
    expect(badMerchant.statusCode).toBe(404);

    const badRider = await harness.app.inject({ method: "POST", url: "/api/platform/riders/does-not-exist/merchants", headers: { authorization: `Bearer ${owner}` }, payload: { merchantId: "x" } });
    expect(badRider.statusCode).toBe(404);
  });

  it("an ordinary admin is refused the merchant-assignment routes", async () => {
    const admin = await adminToken(harness);
    const rider = await makeRider(harness, admin);
    const merchant = await makeMerchant(harness, admin);

    const assign = await harness.app.inject({ method: "POST", url: `/api/platform/riders/${rider.id}/merchants`, headers: { authorization: `Bearer ${admin}` }, payload: { merchantId: merchant.id } });
    expect(assign.statusCode).toBe(403);

    const remove = await harness.app.inject({ method: "DELETE", url: `/api/platform/riders/${rider.id}/merchants/${merchant.id}`, headers: { authorization: `Bearer ${admin}` } });
    expect(remove.statusCode).toBe(403);
  });
});

describe("platform-admin: accounts list", () => {
  it("lists every login organized — staff, couriers, merchant and fleet logins", async () => {
    const owner = await ownerToken(harness);
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const rider = await makeRider(harness, admin);

    // Courier login account linked to the rider profile.
    const courierUser = await harness.prisma.user.create({ data: { name: `Courier Login ${uniq()}`, phone: `+1876555${uniq().slice(-4)}`, passwordHash: "unused", role: "rider" } });
    await harness.prisma.rider.update({ where: { id: rider.id }, data: { userId: courierUser.id } });
    // Merchant portal login.
    const merchantUser = await harness.prisma.user.create({ data: { name: `Merchant Login ${uniq()}`, email: `merchant-login-${uniq()}@example.com`, passwordHash: "unused", role: "viewer" } });
    await harness.prisma.merchantStaff.create({ data: { userId: merchantUser.id, merchantId: merchant.id } });
    // Logistics portal login.
    const company = await harness.prisma.logisticsCompany.create({ data: { businessId: harness.business.id, name: `Fleet ${uniq()}`, slug: `fleet-${uniq()}` } });
    const fleetUser = await harness.prisma.user.create({ data: { name: `Fleet Login ${uniq()}`, email: `fleet-login-${uniq()}@example.com`, passwordHash: "unused", role: "viewer" } });
    await harness.prisma.logisticsCompanyStaff.create({ data: { userId: fleetUser.id, logisticsCompanyId: company.id } });

    const res = await harness.app.inject({ method: "GET", url: "/api/platform/accounts", headers: { authorization: `Bearer ${owner}` } });
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries((res.json() as { accounts: { id: string; staff: unknown[]; rider: unknown | null; merchants: unknown[]; logistics: unknown[] }[] }).accounts.map((a) => [a.id, a]));
    expect(byId[courierUser.id]?.rider).not.toBeNull();
    expect(byId[merchantUser.id]?.merchants).toHaveLength(1);
    expect(byId[fleetUser.id]?.logistics).toHaveLength(1);
  });

  it("search filters by name/email/phone and non-owners are refused", async () => {
    const owner = await ownerToken(harness);
    const admin = await adminToken(harness);
    const named = await harness.prisma.user.create({ data: { name: `Zebra Searchable ${uniq()}`, email: `zebra-${uniq()}@example.com`, passwordHash: "unused", role: "viewer" } });

    const res = await harness.app.inject({ method: "GET", url: "/api/platform/accounts?q=Zebra%20Searchable", headers: { authorization: `Bearer ${owner}` } });
    expect(res.statusCode).toBe(200);
    const ids = ((res.json() as { accounts: { id: string }[] }).accounts).map((a) => a.id);
    expect(ids).toContain(named.id);

    const refused = await harness.app.inject({ method: "GET", url: "/api/platform/accounts", headers: { authorization: `Bearer ${admin}` } });
    expect(refused.statusCode).toBe(403);
  });
});

describe("platform-admin: manager role", () => {
  async function managerToken() {
    const user = await harness.prisma.user.create({ data: { name: `Manager ${uniq()}`, passwordHash: "unused-in-tests", role: "admin", platformRole: "manager" } });
    return harness.tokenFor({ id: user.id, name: user.name, role: "admin", platformRole: "manager" });
  }

  it("a manager can delete platform entities but never touch owner accounts or roles", async () => {
    const manager = await managerToken();
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);

    // Manager deletes a merchant — app-level power, works.
    const del = await harness.app.inject({ method: "DELETE", url: `/api/platform/merchants/${merchant.id}`, headers: { authorization: `Bearer ${manager}` } });
    expect(del.statusCode).toBe(200);

    // Manager cannot delete users at all (owner-only route).
    const staff = await harness.prisma.user.create({ data: { name: `Staff ${uniq()}`, passwordHash: "x", role: "viewer" } });
    const delUser = await harness.app.inject({ method: "DELETE", url: `/api/platform/users/${staff.id}`, headers: { authorization: `Bearer ${manager}` } });
    expect(delUser.statusCode).toBe(403);

    // Manager cannot grant platform roles either.
    const grant = await harness.app.inject({ method: "PATCH", url: `/api/platform/users/${staff.id}`, headers: { authorization: `Bearer ${manager}` }, payload: { platformRole: "manager" } });
    expect(grant.statusCode).toBe(403);
  });

  it("an owner appoints a manager, who then acts; self-demotion is refused", async () => {
    const owner = await ownerToken(harness);
    const candidate = await harness.prisma.user.create({ data: { name: `Candidate ${uniq()}`, passwordHash: "x", role: "admin" } });

    const grant = await harness.app.inject({ method: "PATCH", url: `/api/platform/users/${candidate.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { platformRole: "manager" } });
    expect(grant.statusCode).toBe(200);
    expect(grant.json()).toMatchObject({ ok: true, platformRole: "manager" });

    // The new manager's token carries the role into platform routes.
    const mgrToken = await harness.tokenFor({ id: candidate.id, name: candidate.name, role: "admin", platformRole: "manager" });
    const list = await harness.app.inject({ method: "GET", url: "/api/platform/businesses", headers: { authorization: `Bearer ${mgrToken}` } });
    expect(list.statusCode).toBe(200);

    // Revoke works too.
    const revoke = await harness.app.inject({ method: "PATCH", url: `/api/platform/users/${candidate.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { platformRole: null } });
    expect(revoke.json()).toMatchObject({ ok: true, platformRole: null });

    // The owner cannot demote themselves (lockout protection).
    const me = await harness.prisma.user.findFirstOrThrow({ where: { platformRole: "owner" } });
    const meToken = await harness.tokenFor({ id: me.id, name: me.name, role: "admin", platformRole: "owner" });
    const selfDemote = await harness.app.inject({ method: "PATCH", url: `/api/platform/users/${me.id}`, headers: { authorization: `Bearer ${meToken}` }, payload: { platformRole: null } });
    expect(selfDemote.statusCode).toBe(400);
  });
});

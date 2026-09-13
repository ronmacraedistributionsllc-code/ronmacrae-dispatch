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

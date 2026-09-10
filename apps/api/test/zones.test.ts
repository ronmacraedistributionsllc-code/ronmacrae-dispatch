/**
 * Integration tests for owner/admin-only delivery-fee zone management (create,
 * update, enable/disable, delete) and the address-search route it's built on top
 * of. Same real app + real sqlite db harness as offers.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;

async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: "Owner Admin", passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin" });
}

async function dispatcherToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: "Dee Dispatcher", passwordHash: "unused-in-tests", role: "dispatcher" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "dispatcher" });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-zones");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("zone writes are owner/admin-only", () => {
  it("a dispatcher cannot create a zone", async () => {
    const token = await dispatcherToken(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/zones",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Test Zone", center: { lat: 18.0, lng: -76.8 }, baseFee: 300 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a dispatcher can still read zones (used for order entry / quoting)", async () => {
    const token = await dispatcherToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/zones", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it("an admin can create a zone from a center point, with an urgent surcharge", async () => {
    const token = await adminToken(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/zones",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `Test Zone ${Date.now()}`, center: { lat: 18.1, lng: -77.0 }, baseFee: 400, urgentSurchargeFee: 150 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { zone: { id: string; baseFee: { amount: number }; urgentSurchargeFee: { amount: number } | null; geometry: { type: string } } };
    expect(body.zone.baseFee.amount).toBe(400);
    expect(body.zone.urgentSurchargeFee?.amount).toBe(150);
    // A real, usable polygon was generated from the center point — not left empty.
    expect(body.zone.geometry.type).toBe("Polygon");
  });

  it("rejects a zone with neither geometry nor center", async () => {
    const token = await adminToken(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/zones",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "No Location Zone", baseFee: 300 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a dispatcher cannot update or delete a zone; an admin can", async () => {
    const adminAuth = await adminToken(harness);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/zones",
      headers: { authorization: `Bearer ${adminAuth}` },
      payload: { name: `Update Test Zone ${Date.now()}`, center: { lat: 18.2, lng: -77.2 }, baseFee: 300 },
    });
    const zoneId = (created.json() as { zone: { id: string } }).zone.id;

    const dispatcherAuth = await dispatcherToken(harness);
    const dispatcherPatch = await harness.app.inject({
      method: "PATCH",
      url: `/api/zones/${zoneId}`,
      headers: { authorization: `Bearer ${dispatcherAuth}` },
      payload: { active: false },
    });
    expect(dispatcherPatch.statusCode).toBe(403);
    const dispatcherDelete = await harness.app.inject({ method: "DELETE", url: `/api/zones/${zoneId}`, headers: { authorization: `Bearer ${dispatcherAuth}` } });
    expect(dispatcherDelete.statusCode).toBe(403);

    const adminPatch = await harness.app.inject({
      method: "PATCH",
      url: `/api/zones/${zoneId}`,
      headers: { authorization: `Bearer ${adminAuth}` },
      payload: { active: false, urgentSurchargeFee: 200 },
    });
    expect(adminPatch.statusCode).toBe(200);
    const patched = adminPatch.json() as { zone: { active: boolean; urgentSurchargeFee: { amount: number } | null } };
    expect(patched.zone.active).toBe(false);
    expect(patched.zone.urgentSurchargeFee?.amount).toBe(200);

    const adminDelete = await harness.app.inject({ method: "DELETE", url: `/api/zones/${zoneId}`, headers: { authorization: `Bearer ${adminAuth}` } });
    expect(adminDelete.statusCode).toBe(200);
  });

  it("refuses to delete a zone that has orders on record (disable instead)", async () => {
    const adminAuth = await adminToken(harness);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/zones",
      headers: { authorization: `Bearer ${adminAuth}` },
      payload: { name: `Zone With Orders ${Date.now()}`, center: { lat: 18.3, lng: -77.3 }, baseFee: 300 },
    });
    const zoneId = (created.json() as { zone: { id: string } }).zone.id;
    const customer = await harness.prisma.customer.create({ data: { name: "Zone Delete Test Customer", phone: `+1876${Date.now()}` } });
    await harness.prisma.job.create({ data: { customerId: customer.id, zoneId, status: "new" } });

    const res = await harness.app.inject({ method: "DELETE", url: `/api/zones/${zoneId}`, headers: { authorization: `Bearer ${adminAuth}` } });
    expect(res.statusCode).toBe(409);
  });
});

describe("public address search", () => {
  it(
    "returns at least one candidate for a Jamaican address, with a clear signal when it's the offline fallback",
    async () => {
      const res = await harness.app.inject({ method: "POST", url: "/api/geo/geocode", payload: { query: "Half Way Tree, Kingston, Jamaica", limit: 3 } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { results: { point: { lat: number; lng: number }; label: string; provider: string }[]; degraded: boolean };
      expect(body.results.length).toBeGreaterThan(0);
      expect(typeof body.degraded).toBe("boolean");
    },
    15_000,
  );

  it("rejects a too-short query", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/api/geo/geocode", payload: { query: "a" } });
    expect(res.statusCode).toBe(400);
  });
});

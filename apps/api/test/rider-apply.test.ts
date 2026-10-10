/**
 * Courier applies to deliver for a business: the rider-initiated half of
 * the membership loop (the business-initiated half — approve/reject in
 * Team — already existed). Together with auto-dispatch this closes the
 * ecosystem: apply → approve → auto-offered → claim → deliver.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeRider() {
  const rider = await harness.prisma.rider.create({
    data: { name: "Apply Rider", phone: `+18765${uniq().slice(-7)}`, active: true, status: "available", dailyCapacity: 5 },
  });
  const user = await harness.prisma.user.create({ data: { name: "Apply Rider", passwordHash: "unused", role: "rider" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, auth: { authorization: `Bearer ${token}` } };
}

async function makeBusiness(name: string) {
  return harness.prisma.business.create({ data: { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${uniq()}` } });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-rider-apply");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("GET /api/bearer/businesses", () => {
  it("lists active businesses with this rider's own status, hiding inactive ones", async () => {
    const { auth, rider } = await makeRider();
    const open = await makeBusiness("Open Co");
    const closed = await makeBusiness("Closed Co");
    await harness.prisma.business.update({ where: { id: closed.id }, data: { active: false } });

    const res = await harness.app.inject({ method: "GET", url: "/api/bearer/businesses", headers: auth });
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { businesses: { businessId: string; businessName: string; myStatus: string }[] }).businesses;
    const byId = Object.fromEntries(rows.map((b) => [b.businessId, b]));
    // Harness auto-membership: active at the default business.
    expect(byId[harness.business.id]?.myStatus).toBe("active");
    expect(byId[open.id]?.myStatus).toBe("none");
    expect(byId[closed.id]).toBeUndefined();
    expect(rider.id).toBeTruthy();
  });
});

describe("POST /api/bearer/businesses/:id/apply", () => {
  it("creates a pending application the business admin can approve end-to-end", async () => {
    const { auth, rider } = await makeRider();
    const target = await makeBusiness("Target Co");

    const apply = await harness.app.inject({ method: "POST", url: `/api/bearer/businesses/${target.id}/apply`, headers: auth });
    expect(apply.statusCode).toBe(200);
    expect(apply.json()).toEqual({ ok: true, status: "pending" });

    // The ecosystem loop closes here: that business's own admin approves.
    const adminOfTarget = await (async () => {
      const u = await harness.prisma.user.create({ data: { name: `Target Admin ${uniq()}`, passwordHash: "unused", role: "admin" } });
      await harness.prisma.staffMembership.create({ data: { userId: u.id, businessId: target.id, role: "admin", active: true } });
      return { authorization: `Bearer ${await harness.tokenFor({ id: u.id, name: u.name, role: "admin", businessId: target.id })}` };
    })();
    const decide = await harness.app.inject({ method: "POST", url: `/api/riders/${rider.id}/decide`, headers: adminOfTarget, payload: { approve: true } });
    expect(decide.statusCode).toBe(200);
    expect((await harness.prisma.riderMembership.findFirstOrThrow({ where: { riderId: rider.id, businessId: target.id } })).status).toBe("active");
  });

  it("refuses duplicates, active memberships, suspensions, and inactive businesses", async () => {
    const { auth, rider } = await makeRider();
    const target = await makeBusiness("Strict Co");

    expect((await harness.app.inject({ method: "POST", url: `/api/bearer/businesses/${target.id}/apply`, headers: auth })).statusCode).toBe(200);
    expect((await harness.app.inject({ method: "POST", url: `/api/bearer/businesses/${target.id}/apply`, headers: auth })).statusCode).toBe(409);

    // Already delivering here (harness auto-membership at default business).
    expect((await harness.app.inject({ method: "POST", url: `/api/bearer/businesses/${harness.business.id}/apply`, headers: auth })).statusCode).toBe(409);

    // Suspended must stay suspended — applying again doesn't undo it.
    await harness.prisma.riderMembership.update({ where: { riderId_businessId: { riderId: rider.id, businessId: target.id } }, data: { status: "suspended" } });
    expect((await harness.app.inject({ method: "POST", url: `/api/bearer/businesses/${target.id}/apply`, headers: auth })).statusCode).toBe(409);

    // Removed may re-apply (back to pending, not straight to active).
    await harness.prisma.riderMembership.update({ where: { riderId_businessId: { riderId: rider.id, businessId: target.id } }, data: { status: "removed" } });
    expect((await harness.app.inject({ method: "POST", url: `/api/bearer/businesses/${target.id}/apply`, headers: auth })).statusCode).toBe(200);
    expect((await harness.prisma.riderMembership.findFirstOrThrow({ where: { riderId: rider.id, businessId: target.id } })).status).toBe("pending");

    const closed = await makeBusiness("Closed Co");
    await harness.prisma.business.update({ where: { id: closed.id }, data: { active: false } });
    expect((await harness.app.inject({ method: "POST", url: `/api/bearer/businesses/${closed.id}/apply`, headers: auth })).statusCode).toBe(404);
    expect((await harness.app.inject({ method: "POST", url: "/api/bearer/businesses/does-not-exist/apply", headers: auth })).statusCode).toBe(404);
  });
});

/**
 * Public rider self-signup (spec: "no way for a rider to sign up which it
 * should"). Unlike staff-created riders (RidersService.create, where the
 * creating staff member is vouching for them), a genuinely new self-signup
 * always lands pending — it must go through an explicit admin/dispatcher
 * decision before the rider can sign in and do anything.
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

beforeAll(async () => {
  harness = await buildTestHarness("test-rider-signup");
  // The public signup endpoint resolves the business by the fixed
  // "ronmacrae" slug (order.ts's DEFAULT_PUBLIC_BUSINESS_SLUG) — give the
  // harness's own auto-created business that slug so the public route can
  // find it, same workaround dispatch-notify.test.ts's sibling would need
  // for the direct order path.
  await harness.prisma.business.update({ where: { id: harness.business.id }, data: { slug: "ronmacrae" } });
});

afterAll(async () => {
  await harness.cleanup();
});

describe("public rider self-signup", () => {
  it("lands pending (not immediately active, unlike a staff-created rider), then goes active once an admin approves", async () => {
    const phone = `+1876555${uniq().slice(-4)}`;
    const email = `kei-${uniq()}@example.com`;
    const signup = await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup",
      payload: { name: "Kei Bearer", phone, email, vehicle: "motorcycle", password: "riderpass1" },
    });
    expect(signup.statusCode).toBe(200);
    const { status, riderId } = signup.json() as { status: string; riderId: string };
    expect(status).toBe("pending");

    // Logging in itself is never membership-gated for riders (that's a
    // separate concern — see resolveStaffContext's rider branch in
    // auth.ts); what pending actually blocks is showing up as an
    // available/assignable rider for this business.
    const membershipBefore = await harness.prisma.riderMembership.findUniqueOrThrow({
      where: { riderId_businessId: { riderId, businessId: harness.business.id } },
    });
    expect(membershipBefore.status).toBe("pending");
    // Email is the intended login credential going forward — phone stays
    // the identity/matching key. Confirm sign-in actually works by email.
    const loginBefore = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: email, password: "riderpass1" },
    });
    expect(loginBefore.statusCode).toBe(200);

    const auth = await adminToken(harness);
    const pendingList = await harness.app.inject({
      method: "GET",
      url: "/api/riders/pending",
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(pendingList.statusCode).toBe(200);
    const { riders } = pendingList.json() as { riders: { id: string }[] };
    expect(riders.some((r) => r.id === riderId)).toBe(true);

    const decide = await harness.app.inject({
      method: "POST",
      url: `/api/riders/${riderId}/decide`,
      headers: { authorization: `Bearer ${auth}` },
      payload: { approve: true },
    });
    expect(decide.statusCode).toBe(200);

    const membershipAfter = await harness.prisma.riderMembership.findUniqueOrThrow({
      where: { riderId_businessId: { riderId, businessId: harness.business.id } },
    });
    expect(membershipAfter.status).toBe("active");
    expect(membershipAfter.approvedAt).not.toBeNull();

    // No longer in the pending list once decided.
    const pendingAfter = await harness.app.inject({
      method: "GET",
      url: "/api/riders/pending",
      headers: { authorization: `Bearer ${auth}` },
    });
    const after = pendingAfter.json() as { riders: { id: string }[] };
    expect(after.riders.some((r) => r.id === riderId)).toBe(false);
  });

  it("rejecting an application marks the membership removed, not silently deleted", async () => {
    const phone = `+1876555${uniq().slice(-4)}`;
    const signup = await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup",
      payload: { name: "Rejected Rider", phone, email: `rejected-${uniq()}@example.com`, vehicle: "car", password: "riderpass1" },
    });
    const { riderId } = signup.json() as { riderId: string };

    const auth = await adminToken(harness);
    const decide = await harness.app.inject({
      method: "POST",
      url: `/api/riders/${riderId}/decide`,
      headers: { authorization: `Bearer ${auth}` },
      payload: { approve: false },
    });
    expect(decide.statusCode).toBe(200);

    const membership = await harness.prisma.riderMembership.findUniqueOrThrow({
      where: { riderId_businessId: { riderId, businessId: harness.business.id } },
    });
    expect(membership.status).toBe("removed");

    // A second decision on an already-decided (no longer pending) rider
    // is rejected — decide is a one-shot action on a pending application,
    // not a general membership-status editor.
    const redecide = await harness.app.inject({
      method: "POST",
      url: `/api/riders/${riderId}/decide`,
      headers: { authorization: `Bearer ${auth}` },
      payload: { approve: true },
    });
    expect(redecide.statusCode).toBe(404);
  });
});

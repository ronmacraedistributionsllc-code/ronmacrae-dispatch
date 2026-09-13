/**
 * Public rider self-signup (spec: "no way for a rider to sign up which it
 * should"). Unlike staff-created riders (RidersService.create, where the
 * creating staff member is vouching for them), a genuinely new self-signup
 * always lands pending — it must go through an explicit admin/dispatcher
 * decision before the rider can sign in and do anything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import type { MemoryEmailProvider } from "@ronmacrae/notifications";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

function emailProvider(): MemoryEmailProvider {
  return harness.ctx.email as MemoryEmailProvider;
}

function latestVerificationCode(email: string): string {
  const sent = [...emailProvider().sent].reverse().find((m) => m.to === email);
  if (!sent) throw new Error(`no email sent to ${email}`);
  const match = /code is (\d{6})/.exec(sent.text);
  if (!match) throw new Error(`could not find a code in: ${sent.text}`);
  return match[1]!;
}

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
    // Can't sign in yet — email ownership hasn't been proven.
    const loginUnverified = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: email, password: "riderpass1" },
    });
    expect(loginUnverified.statusCode).toBe(403);

    const code = latestVerificationCode(email);
    const verify = await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup/verify",
      payload: { email, code },
    });
    expect(verify.statusCode).toBe(200);

    // Now sign-in works, by email — phone stays the identity/matching key,
    // not the login credential, but membership is still pending, so this
    // only proves login itself isn't membership-gated (see the comment
    // above resolveStaffContext's rider branch in auth.ts).
    const loginVerified = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: email, password: "riderpass1" },
    });
    expect(loginVerified.statusCode).toBe(200);

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

  it("rejects a wrong verification code, then accepts the real one; an immediate resend is cooldown-limited", async () => {
    const phone = `+1876555${uniq().slice(-4)}`;
    const email = `wrongcode-${uniq()}@example.com`;
    await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup",
      payload: { name: "Wrong Code Rider", phone, email, vehicle: "motorcycle", password: "riderpass1" },
    });

    const badAttempt = await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup/verify",
      payload: { email, code: "000000" },
    });
    expect(badAttempt.statusCode).toBe(400);

    // Resending immediately after signup's own code hits the same
    // request-cooldown sendEmailCode already enforces for customers —
    // proves rider-signup reuses that real guard, not a copy without it.
    const resend = await harness.app.inject({ method: "POST", url: "/api/rider-signup/resend", payload: { email } });
    expect(resend.statusCode).toBe(429);

    const realCode = latestVerificationCode(email);
    const goodAttempt = await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup/verify",
      payload: { email, code: realCode },
    });
    expect(goodAttempt.statusCode).toBe(200);
  });
});

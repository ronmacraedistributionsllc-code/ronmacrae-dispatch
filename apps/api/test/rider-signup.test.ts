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
import { normalizePhone } from "../src/modules/auth.js";

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

  it("an unverified rider is refused login even after their application is approved — activation requires verification, not just approval", async () => {
    const phone = `+1876555${uniq().slice(-4)}`;
    const email = `neververified-${uniq()}@example.com`;
    const signup = await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup",
      payload: { name: "Never Verified", phone, email, vehicle: "motorcycle", password: "riderpass1" },
    });
    const { riderId } = signup.json() as { riderId: string };

    const auth = await adminToken(harness);
    const decide = await harness.app.inject({ method: "POST", url: `/api/riders/${riderId}/decide`, headers: { authorization: `Bearer ${auth}` }, payload: { approve: true } });
    expect(decide.statusCode).toBe(200);
    const membership = await harness.prisma.riderMembership.findUniqueOrThrow({ where: { riderId_businessId: { riderId, businessId: harness.business.id } } });
    expect(membership.status).toBe("active"); // genuinely approved...

    // ...but never verified their email, so login must still be refused.
    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password: "riderpass1" } });
    expect(login.statusCode).toBe(403);
  });

  it("an expired code is refused the same as one that was never sent", async () => {
    const phone = `+1876555${uniq().slice(-4)}`;
    const email = `expired-${uniq()}@example.com`;
    await harness.app.inject({ method: "POST", url: "/api/rider-signup", payload: { name: "Expired Code", phone, email, vehicle: "motorcycle", password: "riderpass1" } });
    const realCode = latestVerificationCode(email);

    // Simulate real elapsed time rather than waiting out the real 10-minute TTL.
    await harness.prisma.customerEmailCode.updateMany({ where: { email, purpose: "verify_rider_email" }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const verify = await harness.app.inject({ method: "POST", url: "/api/rider-signup/verify", payload: { email, code: realCode } });
    expect(verify.statusCode).toBe(400);
    expect((verify.json() as { error: { message: string } }).error.message).toMatch(/expired/i);
  });
});

// Stage: diagnosing "the verification email isn't arriving" — this is the
// exact failure mode a misconfigured/unreachable email provider produces in
// production, reproduced here by making the memory provider itself report
// a send failure (same EmailSendResult shape a real Resend outage, bad API
// key, or unverified sending domain would return), never by throwing.
describe("public rider self-signup: email provider failure is never silent", () => {
  async function withFailingProvider<T>(fn: () => Promise<T>): Promise<T> {
    const provider = emailProvider();
    const realSend = provider.send.bind(provider);
    provider.send = async () => ({ status: "failed", error: "simulated provider outage" });
    try {
      return await fn();
    } finally {
      provider.send = realSend;
    }
  }

  it("a send failure during signup is reported to the applicant, not swallowed as a false success", async () => {
    const phone = `+1876555${uniq().slice(-4)}`;
    const email = `sendfails-${uniq()}@example.com`;
    const signup = await withFailingProvider(() =>
      harness.app.inject({ method: "POST", url: "/api/rider-signup", payload: { name: "Send Fails", phone, email, vehicle: "motorcycle", password: "riderpass1" } }),
    );
    // A 502, not a false 200 "check your email" — the applicant must be
    // told the truth about what actually happened.
    expect(signup.statusCode).toBe(502);

    // The application itself was still created (not lost) — only the
    // email attempt failed.
    const rider = await harness.prisma.rider.findUniqueOrThrow({ where: { phone: normalizePhone(phone) } });
    expect(rider).toBeTruthy();
    const membership = await harness.prisma.riderMembership.findUniqueOrThrow({ where: { riderId_businessId: { riderId: rider.id, businessId: harness.business.id } } });
    expect(membership.status).toBe("pending");

    // No never-delivered code is left sitting around, and — critically —
    // resubmitting the exact same form (once the provider is healthy
    // again, simulated here by exiting withFailingProvider) actually gets
    // a real code out this time, not another silent no-op.
    const retry = await harness.app.inject({ method: "POST", url: "/api/rider-signup", payload: { name: "Send Fails", phone, email, vehicle: "motorcycle", password: "riderpass1" } });
    expect(retry.statusCode).toBe(200);
    const code = latestVerificationCode(email);
    const verify = await harness.app.inject({ method: "POST", url: "/api/rider-signup/verify", payload: { email, code } });
    expect(verify.statusCode).toBe(200);
  });

  it("resend-verification also surfaces a provider failure honestly instead of claiming success", async () => {
    const phone = `+1876555${uniq().slice(-4)}`;
    const email = `resendfails-${uniq()}@example.com`;
    const signup = await harness.app.inject({ method: "POST", url: "/api/rider-signup", payload: { name: "Resend Fails", phone, email, vehicle: "motorcycle", password: "riderpass1" } });
    expect(signup.statusCode).toBe(200);

    // Wait out the resend cooldown window so the failure below is
    // attributable to the provider, not the unrelated rate limit.
    await harness.prisma.customerEmailCode.updateMany({ where: { email, purpose: "verify_rider_email" }, data: { createdAt: new Date(Date.now() - 60_000) } });

    const resend = await withFailingProvider(() => harness.app.inject({ method: "POST", url: "/api/rider-signup/resend", payload: { email } }));
    expect(resend.statusCode).toBe(502);
  });
});

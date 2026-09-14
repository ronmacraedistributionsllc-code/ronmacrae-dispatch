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
    // auth.ts) NOR email-verification-gated (a never-delivered
    // verification email must never be able to permanently lock out an
    // otherwise-legitimate account — see the same route's own comment);
    // what pending actually blocks is showing up as an
    // available/assignable rider for this business.
    const membershipBefore = await harness.prisma.riderMembership.findUniqueOrThrow({
      where: { riderId_businessId: { riderId, businessId: harness.business.id } },
    });
    expect(membershipBefore.status).toBe("pending");
    // Can sign in right away, by email — password alone is the login
    // credential; nothing about pending membership or unverified email
    // blocks authentication itself.
    const loginBeforeVerify = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: email, password: "riderpass1" },
    });
    expect(loginBeforeVerify.statusCode).toBe(200);

    const code = latestVerificationCode(email);
    const verify = await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup/verify",
      payload: { email, code },
    });
    expect(verify.statusCode).toBe(200);

    // Still works after verifying too — verifying is optional proof of
    // email ownership, not a prerequisite this login route re-checks.
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

  it("a rider who never verified their email logs in immediately once approved — the same credentials they signed up with, no re-verification required", async () => {
    const phone = `+1876555${uniq().slice(-4)}`;
    const email = `neververified-${uniq()}@example.com`;
    const signup = await harness.app.inject({
      method: "POST",
      url: "/api/rider-signup",
      payload: { name: "Never Verified", phone, email, vehicle: "motorcycle", password: "riderpass1" },
    });
    const { riderId } = signup.json() as { riderId: string };
    const user = await harness.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull(); // genuinely never verified...

    const auth = await adminToken(harness);
    const decide = await harness.app.inject({ method: "POST", url: `/api/riders/${riderId}/decide`, headers: { authorization: `Bearer ${auth}` }, payload: { approve: true } });
    expect(decide.statusCode).toBe(200);
    const membership = await harness.prisma.riderMembership.findUniqueOrThrow({ where: { riderId_businessId: { riderId, businessId: harness.business.id } } });
    expect(membership.status).toBe("active"); // ...but genuinely approved.

    // Login must still succeed — the exact password they signed up with,
    // no second signup and no email verification just to start using an
    // approved account.
    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password: "riderpass1" } });
    expect(login.statusCode).toBe(200);
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

  it("a send failure during signup is reported honestly (emailSent: false) but never fails the signup itself — the applicant already has a real, usable account", async () => {
    const phone = `+1876555${uniq().slice(-4)}`;
    const email = `sendfails-${uniq()}@example.com`;
    const signup = await withFailingProvider(() =>
      harness.app.inject({ method: "POST", url: "/api/rider-signup", payload: { name: "Send Fails", phone, email, vehicle: "motorcycle", password: "riderpass1" } }),
    );
    // A real 200 with emailSent: false — not a false "email sent, check
    // your inbox" claim, but also not a failed signup: the outage was in
    // sending a verification code, not in creating the account, and
    // signup must never fail because of the former (see selfSignup's own
    // comment) — a provider outage used to 502 the whole response even
    // though the rider/user/membership rows below already existed,
    // leaving a real account the applicant could never get back to
    // (resubmitting hit "already exists") and could never log into either
    // (login used to require emailVerifiedAt, which a never-delivered
    // code can never satisfy).
    expect(signup.statusCode).toBe(200);
    expect((signup.json() as { emailSent: boolean }).emailSent).toBe(false);

    const rider = await harness.prisma.rider.findUniqueOrThrow({ where: { phone: normalizePhone(phone) } });
    expect(rider).toBeTruthy();
    const membership = await harness.prisma.riderMembership.findUniqueOrThrow({ where: { riderId_businessId: { riderId: rider.id, businessId: harness.business.id } } });
    expect(membership.status).toBe("pending");

    // And — the actual fix — login works immediately with the password
    // just chosen, verification email or not.
    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password: "riderpass1" } });
    expect(login.statusCode).toBe(200);
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

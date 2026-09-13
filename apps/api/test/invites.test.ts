/**
 * Real invite/onboarding flow (spec: "if a person is invited/added to a
 * business, they must get a real usable login/onboarding flow—secure
 * invite link or password setup, role, pending/active/disabled status,
 * resend invite, and revoke invite").
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

function latestInviteLink(email: string): string {
  const sent = [...emailProvider().sent].reverse().find((m) => m.to === email);
  if (!sent) throw new Error(`no invite email sent to ${email}`);
  const match = /(https?:\/\/\S+\/accept-invite\?token=\S+)/.exec(sent.text);
  if (!match) throw new Error(`could not find an invite link in: ${sent.text}`);
  return match[1]!;
}

function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get("token")!;
}

async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: h.business.id });
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

beforeAll(async () => {
  harness = await buildTestHarness("test-invites");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("staff invite: create -> accept -> login", () => {
  it("a brand-new email accepts by setting a password, then can log in with real StaffMembership access", async () => {
    const admin = await adminToken(harness);
    const email = `newstaff-${uniq()}@example.com`;
    const create = await harness.app.inject({
      method: "POST",
      url: "/api/invites/staff",
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, name: "New Dispatcher", role: "dispatcher" },
    });
    expect(create.statusCode).toBe(200);
    const { invite } = create.json() as { invite: { id: string; status: string } };
    expect(invite.status).toBe("pending");

    const token = tokenFromLink(latestInviteLink(email));

    const check = await harness.app.inject({ method: "GET", url: `/api/invites/check/${token}` });
    expect(check.statusCode).toBe(200);
    expect((check.json() as { needsPassword: boolean }).needsPassword).toBe(true);

    const accept = await harness.app.inject({ method: "POST", url: "/api/invites/accept", payload: { token, password: "newstaffpass1" } });
    expect(accept.statusCode).toBe(200);
    expect((accept.json() as { hadExistingAccount: boolean }).hadExistingAccount).toBe(false);

    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password: "newstaffpass1" } });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { workspace: string; user: { role: string } };
    expect(body.workspace).toBe("staff");
    expect(body.user.role).toBe("dispatcher");

    // Accepting again is refused — one-shot.
    const reaccept = await harness.app.inject({ method: "POST", url: "/api/invites/accept", payload: { token, password: "irrelevant1" } });
    expect(reaccept.statusCode).toBe(400);
  });

  it("an email that already has an account attaches the new membership without touching its existing password", async () => {
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const email = `already-has-account-${uniq()}@example.com`;

    // This email already has merchant-portal access with its own password.
    await harness.app.inject({
      method: "POST",
      url: `/api/merchants/${merchant.id}/staff`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, password: "originalpassword1" },
    });

    const create = await harness.app.inject({
      method: "POST",
      url: "/api/invites/staff",
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, role: "viewer" },
    });
    const token = tokenFromLink(latestInviteLink(email));

    const check = await harness.app.inject({ method: "GET", url: `/api/invites/check/${token}` });
    expect((check.json() as { needsPassword: boolean }).needsPassword).toBe(false);

    // No password given at all — accepting for an existing account never needs one.
    const accept = await harness.app.inject({ method: "POST", url: "/api/invites/accept", payload: { token } });
    expect(accept.statusCode).toBe(200);
    expect((accept.json() as { hadExistingAccount: boolean }).hadExistingAccount).toBe(true);

    // The ORIGINAL password still works — never overwritten.
    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password: "originalpassword1" } });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { workspace: string; otherWorkspaces: unknown[] };
    // Now has both merchant access (from the earlier grant) and staff access (from the invite).
    expect(body.workspace).toBe("staff");

    void create;
  });
});

describe("resend and revoke", () => {
  it("resend issues a new working link; the old link stops working", async () => {
    const admin = await adminToken(harness);
    const email = `resend-${uniq()}@example.com`;
    const create = await harness.app.inject({
      method: "POST",
      url: "/api/invites/staff",
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, role: "viewer" },
    });
    const { invite } = create.json() as { invite: { id: string } };
    const oldToken = tokenFromLink(latestInviteLink(email));

    const resend = await harness.app.inject({ method: "POST", url: `/api/invites/${invite.id}/resend`, headers: { authorization: `Bearer ${admin}` } });
    expect(resend.statusCode).toBe(200);
    const newToken = tokenFromLink(latestInviteLink(email));
    expect(newToken).not.toBe(oldToken);

    const oldCheck = await harness.app.inject({ method: "GET", url: `/api/invites/check/${oldToken}` });
    expect(oldCheck.statusCode).toBe(404);

    const newCheck = await harness.app.inject({ method: "GET", url: `/api/invites/check/${newToken}` });
    expect(newCheck.statusCode).toBe(200);
  });

  it("a revoked invite can never be accepted", async () => {
    const admin = await adminToken(harness);
    const email = `revoke-${uniq()}@example.com`;
    const create = await harness.app.inject({
      method: "POST",
      url: "/api/invites/staff",
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, role: "viewer" },
    });
    const { invite } = create.json() as { invite: { id: string } };
    const token = tokenFromLink(latestInviteLink(email));

    const revoke = await harness.app.inject({ method: "POST", url: `/api/invites/${invite.id}/revoke`, headers: { authorization: `Bearer ${admin}` } });
    expect(revoke.statusCode).toBe(200);

    const accept = await harness.app.inject({ method: "POST", url: "/api/invites/accept", payload: { token, password: "irrelevant1" } });
    expect(accept.statusCode).toBe(400);

    // Can't resend or re-revoke an already-revoked invite either.
    const reResend = await harness.app.inject({ method: "POST", url: `/api/invites/${invite.id}/resend`, headers: { authorization: `Bearer ${admin}` } });
    expect(reResend.statusCode).toBe(409);
  });

  it("the invite list is scoped to the caller's own business — never another business's invites", async () => {
    // A second Business row in the SAME harness/db — not a second
    // buildTestHarness() call, which would mutate the shared, process-wide
    // DATABASE_URL that getPrisma()/applyDatabaseEnv() write to and break
    // the original harness's own later queries in this file.
    const businessB = await harness.prisma.business.create({ data: { name: `Business B ${uniq()}` } });
    const adminA = await adminToken(harness);
    const userB = await harness.prisma.user.create({ data: { name: "Admin B", passwordHash: "unused-in-tests", role: "admin" } });
    const adminB = await harness.tokenFor({ id: userB.id, name: userB.name, role: "admin", businessId: businessB.id });

    await harness.app.inject({ method: "POST", url: "/api/invites/staff", headers: { authorization: `Bearer ${adminA}` }, payload: { email: `businessA-${uniq()}@example.com`, role: "viewer" } });

    const listA = await harness.app.inject({ method: "GET", url: "/api/invites", headers: { authorization: `Bearer ${adminA}` } });
    const listB = await harness.app.inject({ method: "GET", url: "/api/invites", headers: { authorization: `Bearer ${adminB}` } });
    expect((listA.json() as { invites: unknown[] }).invites.length).toBeGreaterThan(0);
    expect((listB.json() as { invites: unknown[] }).invites.length).toBe(0);
  });
});

describe("merchant invite", () => {
  it("invites someone directly to a merchant workspace, not the whole business", async () => {
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const email = `merchant-invite-${uniq()}@example.com`;
    const create = await harness.app.inject({
      method: "POST",
      url: `/api/invites/merchant/${merchant.id}`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { email },
    });
    expect(create.statusCode).toBe(200);
    const token = tokenFromLink(latestInviteLink(email));
    const accept = await harness.app.inject({ method: "POST", url: "/api/invites/accept", payload: { token, password: "merchantinvite1" } });
    expect(accept.statusCode).toBe(200);

    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password: "merchantinvite1" } });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { workspace: string; merchant: { id: string } };
    expect(body.workspace).toBe("merchant");
    expect(body.merchant.id).toBe(merchant.id);
  });
});

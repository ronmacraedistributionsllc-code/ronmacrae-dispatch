/**
 * One shared sign-in for everyone (spec: "There must be one shared
 * sign-in/sign-up page for everyone. No separate rider, merchant,
 * logistics, or admin login pages... securely determine the person's
 * active role/membership and automatically route them"). POST
 * /api/auth/login is that one endpoint: it now tries staff/rider access
 * first, falls back to merchant-portal access, offers a workspace choice
 * when more than one applies, and gives an honest, specific explanation
 * when neither applies — instead of the old blanket "no active business
 * membership" that fired even for a legitimate merchant-only login.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { hashPassword } from "../src/lib/password.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

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
  return (res.json() as { merchant: { id: string; name: string } }).merchant;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-unified-login");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("one shared login for every kind of account", () => {
  it("a merchant-only account (no staff/rider access) logs in through the SAME endpoint and gets a working merchant workspace", async () => {
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const email = `owner-${uniq()}@vbr.example`;
    await harness.app.inject({
      method: "POST",
      url: `/api/merchants/${merchant.id}/staff`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, password: "merchantpass1" },
    });

    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password: "merchantpass1" } });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { workspace: string; token: string; merchant: { id: string } };
    expect(body.workspace).toBe("merchant");
    expect(body.merchant.id).toBe(merchant.id);

    // The returned token is a real, usable merchant-portal session.
    const me = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/me", headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);
  });

  it("an account with genuinely no access gets a clear, specific explanation, not a generic failure", async () => {
    const email = `nobody-${uniq()}@example.com`;
    await harness.prisma.user.create({ data: { email, name: "Nobody", passwordHash: hashPassword("somepassword1"), role: "viewer" } });
    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password: "somepassword1" } });
    expect(login.statusCode).toBe(403);
    expect((login.json() as { error: { message: string } }).error.message).toMatch(/isn't connected to any business/i);
  });

  it("an account with BOTH staff and merchant access logs in as staff by default, and can switch workspace without a second password", async () => {
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const email = `dual-${uniq()}@example.com`;
    const password = "dualaccess1";

    // Give this same email both a dispatcher StaffMembership and merchant access.
    const dispatcherCreate = await harness.app.inject({
      method: "POST",
      url: "/api/users",
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: "Dual Access", email, password, role: "dispatcher" },
    });
    expect(dispatcherCreate.statusCode).toBe(200);
    await harness.app.inject({
      method: "POST",
      url: `/api/merchants/${merchant.id}/staff`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, password },
    });

    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password } });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { workspace: string; accessToken: string; otherWorkspaces: { type: string; id: string }[] };
    expect(body.workspace).toBe("staff");
    expect(body.otherWorkspaces.some((w) => w.id === merchant.id)).toBe(true);

    // Switch into the merchant workspace without re-entering the password.
    const switchToMerchant = await harness.app.inject({
      method: "POST",
      url: "/api/auth/switch-to-merchant",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(switchToMerchant.statusCode).toBe(200);
    const merchantToken = (switchToMerchant.json() as { token: string }).token;
    const me = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/me", headers: { authorization: `Bearer ${merchantToken}` } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { hasStaffAccess: boolean }).hasStaffAccess).toBe(true);

    // And back the other way, from the merchant token, no password either.
    const switchToStaff = await harness.app.inject({
      method: "POST",
      url: "/api/merchant-portal/switch-to-staff",
      headers: { authorization: `Bearer ${merchantToken}` },
    });
    expect(switchToStaff.statusCode).toBe(200);
    const staffAccessToken = (switchToStaff.json() as { accessToken: string }).accessToken;
    const meStaff = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${staffAccessToken}` } });
    expect(meStaff.statusCode).toBe(200);
  });

  it("multiple merchant workspaces with no staff access at all asks the user to choose, issuing no token yet", async () => {
    const admin = await adminToken(harness);
    const merchantA = await makeMerchant(harness, admin);
    const merchantB = await makeMerchant(harness, admin);
    const email = `multi-merchant-${uniq()}@example.com`;
    const password = "multimerchant1";
    await harness.app.inject({ method: "POST", url: `/api/merchants/${merchantA.id}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email, password } });
    await harness.app.inject({ method: "POST", url: `/api/merchants/${merchantB.id}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email, password } });

    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password } });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { workspace: string; token?: string; options: { id: string }[] };
    expect(body.workspace).toBe("select");
    expect(body.token).toBeUndefined();
    expect(body.options.map((o) => o.id).sort()).toEqual([merchantA.id, merchantB.id].sort());

    // Re-submitting the same credentials plus the chosen id finalizes it —
    // no separate confirm endpoint.
    const finalize = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password, merchantId: merchantB.id } });
    expect(finalize.statusCode).toBe(200);
    const finalized = finalize.json() as { workspace: string; token: string; merchant: { id: string } };
    expect(finalized.workspace).toBe("merchant");
    expect(finalized.merchant.id).toBe(merchantB.id);
  });

  it("a staff account with no merchant access cannot switch to a merchant workspace", async () => {
    const admin = await adminToken(harness);
    const res = await harness.app.inject({ method: "POST", url: "/api/auth/switch-to-merchant", headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * Public self-signup for a Bearer/Logistics Company (spec: the shared
 * sign-up page's fourth account type — "Customer, Courier, Merchant
 * Business, and Bearer/Logistics Company"). Mirrors
 * merchant-portal.test.ts's own merchant-signup coverage, plus the two
 * cases that test explicitly flagged as missing there: a rejection path
 * and disabled-access after a prior approval.
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

/** The signup route resolves the fixed public-storefront business by this
 *  exact slug (order.ts's DEFAULT_PUBLIC_BUSINESS_SLUG) — upserted so
 *  every test in this file can call this helper regardless of order. */
const PUBLIC_BUSINESS_SLUG = "ronmacrae";

async function signupAndVerify(h: TestHarness) {
  await h.prisma.business.upsert({ where: { slug: PUBLIC_BUSINESS_SLUG }, create: { name: "Public Dispatch", slug: PUBLIC_BUSINESS_SLUG }, update: {} });
  const email = `fleet-owner-${uniq()}@example.com`;
  const signup = await h.app.inject({
    method: "POST",
    url: "/api/logistics-signup",
    payload: { ownerName: "Fleet Owner", businessName: `Speedy Fleet ${uniq()}`, email, phone: `+187655${uniq().slice(-5)}`, password: "securepass1" },
  });
  expect(signup.statusCode).toBe(200);
  const { logisticsCompanyId } = signup.json() as { logisticsCompanyId: string };
  const sent = (h.ctx.email as unknown as { sent: { to: string | string[]; text: string }[] }).sent.find((m) => m.to === email);
  const code = sent?.text.match(/code is (\d+)/)?.[1];
  expect(code).toBeTruthy();
  const verify = await h.app.inject({ method: "POST", url: "/api/logistics-signup/verify", payload: { email, code } });
  expect(verify.statusCode).toBe(200);
  return { email, logisticsCompanyId };
}

beforeAll(async () => {
  harness = await buildTestHarness("test-logistics-signup");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("logistics company self-signup", () => {
  it("creates a pending application, blocks login until Platform Admin approves, then lets it log in", async () => {
    // A platform-owner account with an email set — notifyOwnersOfApplication
    // (fired at signup time, not approval time) only has somewhere to send
    // to when one exists; ownerToken() below deliberately omits email so
    // other tests in this file don't pick up a stray notification.
    await harness.prisma.user.create({ data: { name: "Notified Owner", email: `notify-owner-${uniq()}@example.com`, passwordHash: "unused-in-tests", role: "admin", platformRole: "owner", active: true } });

    const { email, logisticsCompanyId } = await signupAndVerify(harness);
    const row = await harness.prisma.logisticsCompany.findUniqueOrThrow({ where: { id: logisticsCompanyId } });
    expect(row.applicationStatus).toBe("pending");
    expect(row.active).toBe(false);

    const beforeApproval = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "securepass1" } });
    expect(beforeApproval.statusCode).toBe(403);

    const owner = await ownerToken(harness);
    const approve = await harness.app.inject({
      method: "POST",
      url: `/api/platform/logistics-companies/${logisticsCompanyId}/review`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { decision: "approve" },
    });
    expect(approve.statusCode).toBe(200);
    expect((approve.json() as { applicationStatus: string; active: boolean }).applicationStatus).toBe("approved");

    const login = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "securepass1" } });
    expect(login.statusCode).toBe(200);

    // Platform Admin notified — best-effort, but the memory provider lets us
    // confirm it was actually attempted (spec: "notify the platform admin").
    const notifyEmail = (harness.ctx.email as unknown as { sent: { subject: string; text: string }[] }).sent.find((m) => m.subject.includes("logistics company application"));
    expect(notifyEmail).toBeTruthy();
    expect(notifyEmail?.text).toContain(email);
  });

  it("rejects a pending application with a reason, and login stays refused — distinct from a plain disable", async () => {
    const { email, logisticsCompanyId } = await signupAndVerify(harness);
    const owner = await ownerToken(harness);

    const missingReason = await harness.app.inject({
      method: "POST",
      url: `/api/platform/logistics-companies/${logisticsCompanyId}/review`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { decision: "reject" },
    });
    expect(missingReason.statusCode).toBe(400);

    const reject = await harness.app.inject({
      method: "POST",
      url: `/api/platform/logistics-companies/${logisticsCompanyId}/review`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { decision: "reject", reason: "Fleet insurance documentation was incomplete" },
    });
    expect(reject.statusCode).toBe(200);
    expect((reject.json() as { applicationStatus: string; active: boolean }).applicationStatus).toBe("rejected");

    const row = await harness.prisma.logisticsCompany.findUniqueOrThrow({ where: { id: logisticsCompanyId } });
    expect(row.applicationStatus).toBe("rejected");
    expect(row.active).toBe(false);
    expect(row.rejectionReason).toBe("Fleet insurance documentation was incomplete");
    expect(row.reviewedAt).toBeTruthy();

    const login = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "securepass1" } });
    expect(login.statusCode).toBe(403);

    // Reviewing it again (in either direction) is refused — it's already decided.
    const reReview = await harness.app.inject({
      method: "POST",
      url: `/api/platform/logistics-companies/${logisticsCompanyId}/review`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { decision: "approve" },
    });
    expect(reReview.statusCode).toBe(409);

    // The plain active-toggle route also refuses a still-pending one — this
    // one already isn't pending (it's rejected), so the toggle route works
    // normally for it, same as any other reviewed merchant/company.
    const disable = await harness.app.inject({
      method: "PATCH",
      url: `/api/platform/logistics-companies/${logisticsCompanyId}`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { active: false },
    });
    expect(disable.statusCode).toBe(200);
  });

  it("refuses the plain active-toggle route on a still-pending application, directing to /review instead", async () => {
    const { logisticsCompanyId } = await signupAndVerify(harness);
    const owner = await ownerToken(harness);
    const patch = await harness.app.inject({
      method: "PATCH",
      url: `/api/platform/logistics-companies/${logisticsCompanyId}`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { active: true },
    });
    expect(patch.statusCode).toBe(400);
  });

  it("disabled access after approval is refused the same way as a never-approved application", async () => {
    const { email, logisticsCompanyId } = await signupAndVerify(harness);
    const owner = await ownerToken(harness);
    await harness.app.inject({
      method: "POST",
      url: `/api/platform/logistics-companies/${logisticsCompanyId}/review`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { decision: "approve" },
    });
    const loginWorks = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "securepass1" } });
    expect(loginWorks.statusCode).toBe(200);

    const disable = await harness.app.inject({
      method: "PATCH",
      url: `/api/platform/logistics-companies/${logisticsCompanyId}`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { active: false },
    });
    expect(disable.statusCode).toBe(200);

    const loginAfterDisable = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "securepass1" } });
    expect(loginAfterDisable.statusCode).toBe(403);
  });
});

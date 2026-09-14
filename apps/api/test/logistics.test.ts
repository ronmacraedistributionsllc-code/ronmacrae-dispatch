/**
 * Bearer/Logistics company (Stage 36) — admin CRUD, its own portal login
 * (same "distinct auth face" pattern as merchant-portal.ts), and Platform
 * Admin's rider-attachment control. Attachment's actual effect on offer
 * eligibility is covered in offers.test.ts (eligibleRiders()); this file
 * covers the surrounding CRUD/auth/portal plumbing and isolation.
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

async function ownerToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Owner ${uniq()}`, passwordHash: "unused-in-tests", role: "admin", platformRole: "owner" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", platformRole: "owner" });
}

async function makeCompany(h: TestHarness, auth: string, overrides: Record<string, unknown> = {}) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/logistics-companies",
    headers: { authorization: `Bearer ${auth}` },
    payload: { name: `Swift Riders ${uniq()}`, ...overrides },
  });
  return (res.json() as { logisticsCompany: { id: string; name: string; slug: string } }).logisticsCompany;
}

async function makeRider(h: TestHarness, auth: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/riders",
    headers: { authorization: `Bearer ${auth}` },
    payload: { name: `Rider ${uniq()}`, phone: `+1876557${uniq().slice(-4)}` },
  });
  return (res.json() as { rider: { id: string } }).rider;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-logistics");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("logistics companies: admin CRUD", () => {
  it("creates a company with a derived slug, lists it, and can disable/reactivate it", async () => {
    const admin = await adminToken(harness);
    const company = await makeCompany(harness, admin);
    expect(company.slug).toMatch(/^swift-riders-/);

    const list = await harness.app.inject({ method: "GET", url: "/api/logistics-companies", headers: { authorization: `Bearer ${admin}` } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { logisticsCompanies: { id: string }[] }).logisticsCompanies.some((c) => c.id === company.id)).toBe(true);

    const disable = await harness.app.inject({ method: "PATCH", url: `/api/logistics-companies/${company.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { active: false } });
    expect(disable.statusCode).toBe(200);
    expect((disable.json() as { logisticsCompany: { active: boolean } }).logisticsCompany.active).toBe(false);
  });

  it("refuses a non-owner-business-admin's staff routes but allows dispatcher read access", async () => {
    const admin = await adminToken(harness);
    const company = await makeCompany(harness, admin);
    const dispatcherUser = await harness.prisma.user.create({ data: { name: `Disp ${uniq()}`, passwordHash: "unused-in-tests", role: "dispatcher" } });
    const dispatcher = await harness.tokenFor({ id: dispatcherUser.id, name: dispatcherUser.name, role: "dispatcher", businessId: harness.business.id });

    const read = await harness.app.inject({ method: "GET", url: `/api/logistics-companies/${company.id}`, headers: { authorization: `Bearer ${dispatcher}` } });
    expect(read.statusCode).toBe(200);

    const createAttempt = await harness.app.inject({ method: "POST", url: "/api/logistics-companies", headers: { authorization: `Bearer ${dispatcher}` }, payload: { name: "Nope Ltd" } });
    expect(createAttempt.statusCode).toBe(403);
  });
});

describe("logistics portal: its own auth face", () => {
  it("logs in with granted credentials, sees only its own fleet, and a bad password is refused", async () => {
    const admin = await adminToken(harness);
    const companyA = await makeCompany(harness, admin);
    const companyB = await makeCompany(harness, admin);
    const email = `fleet-${uniq()}@swift.example`;

    const grant = await harness.app.inject({
      method: "POST",
      url: `/api/logistics-companies/${companyA.id}/staff`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, name: "Fleet Owner", password: "fleetpass1" },
    });
    expect(grant.statusCode).toBe(200);

    const badLogin = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "wrong-password" } });
    expect(badLogin.statusCode).toBe(401);

    const login = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "fleetpass1" } });
    expect(login.statusCode).toBe(200);
    const { token, logisticsCompany } = login.json() as { token: string; logisticsCompany: { id: string } };
    expect(logisticsCompany.id).toBe(companyA.id);

    const noAuth = await harness.app.inject({ method: "GET", url: "/api/logistics-portal/riders" });
    expect(noAuth.statusCode).toBe(401);

    // Attach one rider to company A (Platform Admin's call, not the portal's).
    const rider = await makeRider(harness, admin);
    const owner = await ownerToken(harness);
    const attach = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { attachment: "logistics", attachedLogisticsCompanyId: companyA.id } });
    expect(attach.statusCode).toBe(200);

    const riders = await harness.app.inject({ method: "GET", url: "/api/logistics-portal/riders", headers: { authorization: `Bearer ${token}` } });
    expect(riders.statusCode).toBe(200);
    const { riders: fleet } = riders.json() as { riders: { id: string }[] };
    expect(fleet.some((r) => r.id === rider.id)).toBe(true);

    // Company B's login must never see company A's fleet.
    const emailB = `fleetb-${uniq()}@swift.example`;
    await harness.app.inject({ method: "POST", url: `/api/logistics-companies/${companyB.id}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email: emailB, password: "fleetpass1" } });
    const loginB = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email: emailB, password: "fleetpass1" } });
    const tokenB = (loginB.json() as { token: string }).token;
    const fleetB = await harness.app.inject({ method: "GET", url: "/api/logistics-portal/riders", headers: { authorization: `Bearer ${tokenB}` } });
    expect((fleetB.json() as { riders: { id: string }[] }).riders.some((r) => r.id === rider.id)).toBe(false);
  });

  it("a staff access token cannot be used against logistics-portal routes", async () => {
    const admin = await adminToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/logistics-portal/riders", headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(401);
  });

  it("shows a company its own attached rider's real deliveries — deliberately without the dispatching business's customer name/phone/address", async () => {
    const admin = await adminToken(harness);
    const owner = await ownerToken(harness);
    const company = await makeCompany(harness, admin);
    const email = `fleet-jobs-${uniq()}@swift.example`;
    await harness.app.inject({ method: "POST", url: `/api/logistics-companies/${company.id}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email, password: "fleetpass1" } });
    const login = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "fleetpass1" } });
    const { token } = login.json() as { token: string };

    const rider = await makeRider(harness, admin);
    await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { attachment: "logistics", attachedLogisticsCompanyId: company.id } });

    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Real Customer Name", phone: `+1876599${uniq().slice(-4)}` } });
    const jobRes = await harness.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { authorization: `Bearer ${admin}` },
      payload: { customerId: customer.id, pickupAddressText: "10 Duke Street", itemSummary: "Fleet Test Parcel", fare: 1500, fee: 200, paymentMethod: "cod", scheduledAt: new Date().toISOString() },
    });
    expect(jobRes.statusCode).toBe(200);
    const job = (jobRes.json() as { job: { id: string; jobNumber: string } }).job;
    const assign = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/assignments`, headers: { authorization: `Bearer ${admin}` }, payload: { riderId: rider.id } });
    expect(assign.statusCode).toBe(200);

    // A rider not attached to this company at all — its jobs list must 404, not leak.
    const otherRider = await makeRider(harness, admin);
    const otherJobsRes = await harness.app.inject({ method: "GET", url: `/api/logistics-portal/riders/${otherRider.id}/jobs`, headers: { authorization: `Bearer ${token}` } });
    expect(otherJobsRes.statusCode).toBe(404);

    const jobs = await harness.app.inject({ method: "GET", url: `/api/logistics-portal/riders/${rider.id}/jobs`, headers: { authorization: `Bearer ${token}` } });
    expect(jobs.statusCode).toBe(200);
    const body = jobs.json() as { jobs: { id: string; jobNumber: string | null; status: string; itemSummary: string | null }[] };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]!.jobNumber).toBe(job.jobNumber);
    expect(body.jobs[0]!.itemSummary).toBe("Fleet Test Parcel");
    expect(body.jobs[0]!.status).toBe("assigned");
    // Never the dispatching business's customer PII — this company only supplies the courier.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("Real Customer Name");
    expect(raw).not.toContain(customer.phone);
    expect(raw).not.toContain("10 Duke Street");
  });
});

describe("unified login resolves a logistics-only account to the logistics workspace", () => {
  it("logs in through /api/auth/login and gets a working logistics-portal token", async () => {
    const admin = await adminToken(harness);
    const company = await makeCompany(harness, admin);
    const email = `unified-${uniq()}@swift.example`;
    await harness.app.inject({ method: "POST", url: `/api/logistics-companies/${company.id}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email, password: "unifiedpass1" } });

    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password: "unifiedpass1" } });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { workspace: string; token: string; logisticsCompany: { id: string } };
    expect(body.workspace).toBe("logistics");
    expect(body.logisticsCompany.id).toBe(company.id);

    const me = await harness.app.inject({ method: "GET", url: "/api/logistics-portal/me", headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);
  });

  it("a staff account with logistics access too can switch workspace without re-entering a password", async () => {
    const admin = await adminToken(harness);
    const company = await makeCompany(harness, admin);
    const email = `dual-logistics-${uniq()}@example.com`;
    const password = "duallogistics1";
    await harness.app.inject({
      method: "POST",
      url: "/api/users",
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: "Dual Logistics", email, password, role: "dispatcher" },
    });
    await harness.app.inject({ method: "POST", url: `/api/logistics-companies/${company.id}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email, password } });

    const login = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { identifier: email, password } });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { workspace: string; accessToken: string; otherWorkspaces: { type: string; id: string }[] };
    expect(body.workspace).toBe("staff");
    expect(body.otherWorkspaces.some((w) => w.type === "logistics" && w.id === company.id)).toBe(true);

    const switchToLogistics = await harness.app.inject({ method: "POST", url: "/api/auth/switch-to-logistics", headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(switchToLogistics.statusCode).toBe(200);
    const logisticsToken = (switchToLogistics.json() as { token: string }).token;

    const switchBack = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/switch-to-staff", headers: { authorization: `Bearer ${logisticsToken}` } });
    expect(switchBack.statusCode).toBe(200);
  });
});

describe("platform admin: rider attachment", () => {
  it("requires the matching id, validates it exists, and freelance clears both", async () => {
    const admin = await adminToken(harness);
    const owner = await ownerToken(harness);
    const rider = await makeRider(harness, admin);
    const merchant = await harness.prisma.merchant.create({ data: { businessId: harness.business.id, name: `AttM ${uniq()}`, slug: `attm-${uniq()}` } });

    const missingId = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { attachment: "merchant" } });
    expect(missingId.statusCode).toBe(400);

    const badId = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { attachment: "merchant", attachedMerchantId: "does-not-exist" } });
    expect(badId.statusCode).toBe(404);

    const ok = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { attachment: "merchant", attachedMerchantId: merchant.id } });
    expect(ok.statusCode).toBe(200);
    let row = await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(row.attachment).toBe("merchant");
    expect(row.attachedMerchantId).toBe(merchant.id);

    const backToFreelance = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { attachment: "freelance" } });
    expect(backToFreelance.statusCode).toBe(200);
    row = await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(row.attachment).toBe("freelance");
    expect(row.attachedMerchantId).toBeNull();
  });

  it("the rider list and detail views surface attachment and its target", async () => {
    const admin = await adminToken(harness);
    const owner = await ownerToken(harness);
    const rider = await makeRider(harness, admin);
    const company = await harness.prisma.logisticsCompany.create({ data: { businessId: harness.business.id, name: `AttL ${uniq()}`, slug: `attl-${uniq()}` } });
    await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { attachment: "logistics", attachedLogisticsCompanyId: company.id } });

    const list = await harness.app.inject({ method: "GET", url: "/api/platform/riders", headers: { authorization: `Bearer ${owner}` } });
    const found = (list.json() as { riders: { id: string; attachment: string; attachedLogisticsCompany: { id: string } | null }[] }).riders.find((r) => r.id === rider.id);
    expect(found?.attachment).toBe("logistics");
    expect(found?.attachedLogisticsCompany?.id).toBe(company.id);

    const detail = await harness.app.inject({ method: "GET", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` } });
    const body = detail.json() as { rider: { attachment: string; attachedLogisticsCompany: { id: string } | null } };
    expect(body.rider.attachment).toBe("logistics");
    expect(body.rider.attachedLogisticsCompany?.id).toBe(company.id);
  });
});

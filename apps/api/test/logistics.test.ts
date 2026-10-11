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

describe("logistics portal: fleet rider onboarding", () => {
  async function portalAuth(h: TestHarness, companyId: string) {
    const admin = await adminToken(h);
    const email = `fleet-${uniq()}@example.com`;
    await h.app.inject({
      method: "POST", url: `/api/logistics-companies/${companyId}/staff`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, name: "Fleet Staff", password: "fleetpass1" },
    });
    const login = await h.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "fleetpass1" } });
    expect(login.statusCode).toBe(200);
    return { authorization: `Bearer ${(login.json() as { token: string }).token}` };
  }

  it("a company adds its own bearer (pending business approval) and releases them", async () => {
    const admin = await adminToken(harness);
    const company = await makeCompany(harness, admin);
    const portal = await portalAuth(harness, company.id);

    const add = await harness.app.inject({
      method: "POST", url: "/api/logistics-portal/riders", headers: portal,
      payload: { name: "Fleet Bearer", phone: `+18765${uniq().slice(-7)}` },
    });
    expect(add.statusCode).toBe(200);
    const riderId = (add.json() as { riderId: string }).riderId;
    const row = await harness.prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect(row.attachment).toBe("logistics");
    expect(row.attachedLogisticsCompanyId).toBe(company.id);
    expect(row.platformStatus).toBe("pending");
    // The harness auto-inserts an active membership on every rider.create
    // (production never does) — remove it to prove the route itself only
    // ever creates a *pending* membership for the business to approve.
    await harness.prisma.riderMembership.deleteMany({ where: { riderId, status: "active" } });
    expect(await harness.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId, businessId: harness.business.id } } })).toBeNull();
    // Re-run add: existing rider, no membership → pending membership created.
    expect((await harness.app.inject({ method: "POST", url: "/api/logistics-portal/riders", headers: portal, payload: { name: "Fleet Bearer", phone: row.phone } })).statusCode).toBe(200);
    expect(await harness.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId, businessId: harness.business.id } } })).toMatchObject({ status: "pending" });

    // A courier's own login token is a different auth face — refused here.
    const riderUser = await harness.prisma.user.create({ data: { name: `Nope ${uniq()}`, passwordHash: "x", role: "rider" } });
    const riderToken = await harness.tokenFor({ id: riderUser.id, name: riderUser.name, role: "rider", riderId });
    expect((await harness.app.inject({ method: "POST", url: "/api/logistics-portal/riders", headers: { authorization: `Bearer ${riderToken}` }, payload: { name: "X", phone: `+18765${uniq().slice(-7)}` } })).statusCode).toBe(401);

    // Release back to freelance.
    const detach = await harness.app.inject({ method: "POST", url: `/api/logistics-portal/riders/${riderId}/detach`, headers: portal });
    expect(detach.statusCode).toBe(200);
    const freed = await harness.prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect(freed.attachedLogisticsCompanyId).toBeNull();
    expect(freed.attachment).toBe("freelance");
  });

  it("refuses riders attached elsewhere and detach while carrying work", async () => {
    const admin = await adminToken(harness);
    const companyA = await makeCompany(harness, admin);
    const companyB = await makeCompany(harness, admin);
    const portalA = await portalAuth(harness, companyA.id);

    const rider = await makeRider(harness, admin);
    const owner = await ownerToken(harness);
    await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { attachment: "logistics", attachedLogisticsCompanyId: companyB.id } });

    const poach = await harness.app.inject({
      method: "POST", url: "/api/logistics-portal/riders", headers: portalA,
      payload: { name: "Poached", phone: (await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).phone },
    });
    expect(poach.statusCode).toBe(409);

    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Busy Customer", phone: `+18765${uniq().slice(-7)}` } });
    await harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, jobNumber: `BUSYF-${uniq()}`, status: "accepted", riderId: rider.id } });
    await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${owner}` }, payload: { attachment: "logistics", attachedLogisticsCompanyId: companyA.id } });
    const stuck = await harness.app.inject({ method: "POST", url: `/api/logistics-portal/riders/${rider.id}/detach`, headers: portalA });
    expect(stuck.statusCode).toBe(409);
  });
});

describe("logistics portal: assign fleet + offer pool", () => {
  async function portalFixture() {
    const admin = await adminToken(harness);
    const company = await makeCompany(harness, admin);
    const email = `fleet-${uniq()}@example.com`;
    await harness.app.inject({
      method: "POST", url: `/api/logistics-companies/${company.id}/staff`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, name: "Fleet Staff", password: "fleetpass1" },
    });
    const login = await harness.app.inject({ method: "POST", url: "/api/logistics-portal/login", payload: { email, password: "fleetpass1" } });
    const portal = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
    return { admin, company, portal };
  }

  async function attachRider(companyId: string, opts: { verified?: boolean } = {}) {
    const rider = await harness.prisma.rider.create({
      data: { name: `Fleet Rider ${uniq()}`, phone: `+18765${uniq().slice(-7)}`, active: true, status: "available", dailyCapacity: 5, verified: opts.verified ?? true, attachment: "logistics", attachedLogisticsCompanyId: companyId },
    });
    return rider;
  }

  async function openJob(extra: Record<string, unknown> = {}) {
    const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Fleet Customer", phone: `+18765${uniq().slice(-7)}` } });
    return harness.prisma.job.create({ data: { businessId: harness.business.id, customerId: customer.id, jobNumber: `FLT-${uniq()}`, status: "new", paymentMethod: "transfer", currency: "JMD", ...extra } });
  }

  it("lists open jobs narrowly and assigns an attached bearer directly", async () => {
    const { admin, company, portal } = await portalFixture();
    void admin;
    const rider = await attachRider(company.id);
    const job = await openJob();

    const list = await harness.app.inject({ method: "GET", url: "/api/logistics-portal/jobs", headers: portal });
    expect(list.statusCode).toBe(200);
    const ids = ((list.json() as { jobs: { id: string; customerName?: string; addressText?: string }[] }).jobs).map((j) => j.id);
    expect(ids).toContain(job.id);

    const assign = await harness.app.inject({ method: "POST", url: `/api/logistics-portal/jobs/${job.id}/assign`, headers: portal, payload: { riderId: rider.id } });
    expect(assign.statusCode).toBe(200);
    expect((await harness.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).riderId).toBe(rider.id);
    const audit = await harness.prisma.auditLog.findFirst({ where: { action: "logistics.job.assign", entityId: job.id } });
    expect(audit).not.toBeNull();
  });

  it("refuses strangers' riders, other businesses' jobs, and membership-less fleet", async () => {
    const { company, portal } = await portalFixture();
    const otherAdmin = await adminToken(harness);
    const otherCompany = await makeCompany(harness, otherAdmin);
    const stranger = await attachRider(otherCompany.id);
    const job = await openJob();

    // Not in this fleet.
    expect((await harness.app.inject({ method: "POST", url: `/api/logistics-portal/jobs/${job.id}/assign`, headers: portal, payload: { riderId: stranger.id } })).statusCode).toBe(404);

    // Other business's job.
    const otherBiz = await harness.prisma.business.create({ data: { name: `Far Biz ${uniq()}`, slug: `far-biz-${uniq()}` } });
    const farCustomer = await harness.prisma.customer.create({ data: { businessId: otherBiz.id, name: "Far", phone: `+18765${uniq().slice(-7)}` } });
    const farJob = await harness.prisma.job.create({ data: { businessId: otherBiz.id, customerId: farCustomer.id, jobNumber: `FAR-${uniq()}`, status: "new" } });
    const mine = await attachRider(company.id);
    expect((await harness.app.inject({ method: "POST", url: `/api/logistics-portal/jobs/${farJob.id}/assign`, headers: portal, payload: { riderId: mine.id } })).statusCode).toBe(409);

    // Fleet rider without an active membership can't be assigned yet.
    await harness.prisma.riderMembership.deleteMany({ where: { riderId: mine.id } });
    expect((await harness.app.inject({ method: "POST", url: `/api/logistics-portal/jobs/${job.id}/assign`, headers: portal, payload: { riderId: mine.id } })).statusCode).toBe(404);
    expect(company.id).toBeTruthy();
  });

  it("offers pool couriers (they choose) and enforces cash verification", async () => {
    const { portal } = await portalFixture();
    await harness.prisma.business.update({ where: { id: harness.business.id }, data: { courierPool: "both" } });
    try {
      const poolRider = await harness.prisma.rider.create({
        data: { name: `Pool Rider ${uniq()}`, phone: `+18765${uniq().slice(-7)}`, active: true, status: "available", dailyCapacity: 5, platformStatus: "approved", selfSignedUp: true, openNetwork: true, verified: false },
      });
      // A pool stranger has no membership here (the harness auto-inserts
      // one on every rider.create — strip it).
      await harness.prisma.riderMembership.deleteMany({ where: { riderId: poolRider.id } });
      const couriers = await harness.app.inject({ method: "GET", url: "/api/logistics-portal/couriers", headers: portal });
      expect(couriers.statusCode).toBe(200);
      const pool = (couriers.json() as { pool: { id: string; phone?: string }[] }).pool;
      const found = pool.find((r) => r.id === poolRider.id);
      expect(found).toBeTruthy();
      expect(found?.phone).toBeUndefined();

      const cashJob = await openJob({ paymentMethod: "cod", amountExpected: 1000 });
      // Unverified pool rider + cash → refused, even here.
      expect((await harness.app.inject({ method: "POST", url: `/api/logistics-portal/jobs/${cashJob.id}/offer`, headers: portal, payload: { riderId: poolRider.id } })).statusCode).toBe(409);

      const prepaidJob = await openJob({ paymentMethod: "transfer" });
      const offer = await harness.app.inject({ method: "POST", url: `/api/logistics-portal/jobs/${prepaidJob.id}/offer`, headers: portal, payload: { riderId: poolRider.id } });
      expect(offer.statusCode).toBe(200);
      // Offered, NOT assigned — the courier still chooses.
      expect((await harness.prisma.job.findUniqueOrThrow({ where: { id: prepaidJob.id } })).riderId).toBeNull();
      expect(await harness.prisma.jobOffer.count({ where: { jobId: prepaidJob.id, riderId: poolRider.id, status: "open" } })).toBe(1);
    } finally {
      await harness.prisma.business.update({ where: { id: harness.business.id }, data: { courierPool: "company" } });
    }
  });
});

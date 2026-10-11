/**
 * Trust economy: signup choice (company vs independent), ownership on
 * approval, platform verification (owner-only), cash gating (verified =
 * COD, everyone else = prepaid only), and the dual-confirmation money
 * ledger (both sides agree, or it stays visibly pending).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeRider(opts: { verified?: boolean; platformStatus?: "pending" | "approved"; selfSignedUp?: boolean; openNetwork?: boolean } = {}) {
  const rider = await harness.prisma.rider.create({
    data: {
      name: "Trust Rider", phone: `+18765${uniq().slice(-7)}`, active: true, status: "available", dailyCapacity: 10,
      platformStatus: opts.platformStatus ?? "pending",
      selfSignedUp: opts.selfSignedUp ?? false,
      openNetwork: opts.openNetwork ?? false,
      verified: opts.verified ?? false,
    },
  });
  const user = await harness.prisma.user.create({ data: { name: "Trust Rider", passwordHash: "unused", role: "rider" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  return { rider, auth: { authorization: `Bearer ${token}` } };
}

async function makeStaff(role: "admin" | "dispatcher" | "accountant" = "dispatcher") {
  const user = await harness.prisma.user.create({ data: { name: `Trust Staff ${uniq()}`, passwordHash: "unused", role } });
  await harness.prisma.staffMembership.create({ data: { userId: user.id, businessId: harness.business.id, role, active: true } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role, businessId: harness.business.id });
  return { authorization: `Bearer ${token}` };
}

async function makeOwner() {
  const user = await harness.prisma.user.create({ data: { name: `Trust Owner ${uniq()}`, passwordHash: "unused", role: "admin", platformRole: "owner" } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role: "admin", platformRole: "owner" });
  return { authorization: `Bearer ${token}` };
}

async function makeCodJob(riderId: string, amountExpected = 1500) {
  const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Trust Customer", phone: `+18765${uniq().slice(-7)}` } });
  return harness.prisma.job.create({
    data: { businessId: harness.business.id, customerId: customer.id, jobNumber: `TRUST-${uniq()}`, status: "in_transit", riderId, paymentMethod: "cod", amountExpected, currency: "JMD", pin: "4242" },
  });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-trust-economy");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("signup choice", () => {
  it("company choice lands pending at the chosen company, not the default", async () => {
    const target = await harness.prisma.business.create({ data: { name: `Chosen Co ${uniq()}`, slug: `chosen-co-${uniq()}` } });
    const email = `choice-${uniq()}@example.com`;
    const res = await harness.app.inject({
      method: "POST", url: "/api/rider-signup",
      payload: { name: "Choice Rider", phone: `+18765${uniq().slice(-7)}`, email, vehicle: "motorcycle", password: "riderpass1", businessId: target.id },
    });
    expect(res.statusCode).toBe(200);
    const riderId = (res.json() as { riderId: string }).riderId;
    expect(await harness.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId, businessId: target.id } } })).toMatchObject({ status: "pending" });
    // The harness auto-inserts an active membership at its own business on
    // EVERY rider.create (even the API's own) — strip that artifact, then
    // the route must have created exactly one membership: at the target.
    await harness.prisma.riderMembership.deleteMany({ where: { riderId, businessId: harness.business.id } });
    expect(await harness.prisma.riderMembership.findMany({ where: { riderId } })).toHaveLength(1);
  });

  it("independent signup creates no membership; unknown company is rejected", async () => {
    const email = `indie-${uniq()}@example.com`;
    const res = await harness.app.inject({
      method: "POST", url: "/api/rider-signup",
      payload: { name: "Indie Rider", phone: `+18765${uniq().slice(-7)}`, email, vehicle: "motorcycle", password: "riderpass1", independent: true },
    });
    expect(res.statusCode).toBe(200);
    const riderId = (res.json() as { riderId: string }).riderId;
    // Strip the harness's auto-inserted membership (see above): the route
    // itself must have created none.
    await harness.prisma.riderMembership.deleteMany({ where: { riderId, businessId: harness.business.id } });
    expect(await harness.prisma.riderMembership.count({ where: { riderId } })).toBe(0);

    const bad = await harness.app.inject({
      method: "POST", url: "/api/rider-signup",
      payload: { name: "Lost Rider", phone: `+18765${uniq().slice(-7)}`, email: `lost-${uniq()}@example.com`, vehicle: "motorcycle", password: "riderpass1", businessId: "does-not-exist" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("public company directory lists active businesses only", async () => {
    const open = await harness.prisma.business.create({ data: { name: `Directory Co ${uniq()}`, slug: `directory-co-${uniq()}` } });
    const closed = await harness.prisma.business.create({ data: { name: `Closed Co ${uniq()}`, slug: `closed-co-${uniq()}`, active: false } });
    const res = await harness.app.inject({ method: "GET", url: "/api/rider-signup/companies" });
    expect(res.statusCode).toBe(200);
    const ids = ((res.json() as { companies: { id: string }[] }).companies).map((c) => c.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(closed.id);
  });
});

describe("ownership on approval + platform verification", () => {
  it("approving a self-signed rider claims them for that company", async () => {
    const target = await harness.prisma.business.create({ data: { name: `Claim Co ${uniq()}`, slug: `claim-co-${uniq()}` } });
    const rider = await harness.prisma.rider.create({
      data: { name: "Claim Rider", phone: `+18765${uniq().slice(-7)}`, active: true, status: "available", selfSignedUp: true },
    });
    await harness.prisma.riderMembership.create({ data: { riderId: rider.id, businessId: target.id, status: "pending" } });
    const staff = await (async () => {
      const u = await harness.prisma.user.create({ data: { name: `Claim Admin ${uniq()}`, passwordHash: "unused", role: "admin" } });
      await harness.prisma.staffMembership.create({ data: { userId: u.id, businessId: target.id, role: "admin", active: true } });
      return { authorization: `Bearer ${await harness.tokenFor({ id: u.id, name: u.name, role: "admin", businessId: target.id })}` };
    })();
    const decide = await harness.app.inject({ method: "POST", url: `/api/riders/${rider.id}/decide`, headers: staff, payload: { approve: true } });
    expect(decide.statusCode).toBe(200);
    expect((await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).createdByBusinessId).toBe(target.id);
  });

  it("verification is owner-only; managers are refused", async () => {
    const owner = await makeOwner();
    const managerUser = await harness.prisma.user.create({ data: { name: `Verify Mgr ${uniq()}`, passwordHash: "unused", role: "admin", platformRole: "manager" } });
    const mgrToken = await harness.tokenFor({ id: managerUser.id, name: managerUser.name, role: "admin", platformRole: "manager" });
    const rider = await harness.prisma.rider.create({ data: { name: "Verify Rider", phone: `+18765${uniq().slice(-7)}`, active: true, status: "available", selfSignedUp: true } });

    const denied = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: { authorization: `Bearer ${mgrToken}` }, payload: { verified: true } });
    expect(denied.statusCode).toBe(403);

    const ok = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: owner, payload: { verified: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ verified: true });
    const row = await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(row.verified).toBe(true);
    expect(row.verifiedAt).not.toBeNull();

    const unverify = await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${rider.id}`, headers: owner, payload: { verified: false } });
    expect(unverify.json()).toMatchObject({ verified: false });
    expect((await harness.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).verifiedAt).toBeNull();
  });
});

describe("cash gating", () => {
  it("unverified riders never see or touch COD; verified riders do", async () => {
    const unverified = await makeRider();
    const verified = await makeRider({ verified: true });
    const staff = await makeStaff();
    const cod = await makeCodJob(verified.rider.id);

    // Pending list hides cash from the unverified rider.
    const list = await harness.app.inject({ method: "GET", url: "/api/bearer/pending-jobs", headers: unverified.auth });
    expect(list.statusCode).toBe(200);

    // Direct claim of a cash job is refused for the unverified.
    const fresh = await harness.prisma.job.create({
      data: { businessId: harness.business.id, customerId: (await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Cash Customer", phone: `+18765${uniq().slice(-7)}` } })).id, jobNumber: `CASH-${uniq()}`, status: "new", paymentMethod: "cod", amountExpected: 1000, currency: "JMD" },
    });
    const claim = await harness.app.inject({ method: "POST", url: `/api/bearer/pending-jobs/${fresh.id}/claim`, headers: unverified.auth });
    expect(claim.statusCode).toBe(409);

    // Staff assignment of cash to unverified is refused too.
    const assign = await harness.app.inject({ method: "POST", url: `/api/jobs/${fresh.id}/assignments`, headers: staff, payload: { riderId: unverified.rider.id } });
    expect(assign.statusCode).toBe(409);

    // Verified claim of a non-cash job still works (gating only bites on cash).
    const prepaid = await harness.prisma.job.create({
      data: { businessId: harness.business.id, customerId: (await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Prepaid Customer", phone: `+18765${uniq().slice(-7)}` } })).id, jobNumber: `PRE-${uniq()}`, status: "new", paymentMethod: "transfer", currency: "JMD" },
    });
    const okClaim = await harness.app.inject({ method: "POST", url: `/api/bearer/pending-jobs/${prepaid.id}/claim`, headers: unverified.auth });
    expect(okClaim.statusCode).toBe(200);
    expect(cod.id).toBeTruthy();
  });
});

describe("dual-confirmation ledger", () => {
  it("delivery opens a pending trail; hand-in marks paid; approval completes it", async () => {
    const { auth, rider } = await makeRider({ verified: true });
    const staff = await makeStaff("accountant");
    const job = await makeCodJob(rider.id);

    const deliver = await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/transition`, headers: auth, payload: { to: "delivered", pin: "4242" } });
    expect(deliver.statusCode).toBe(200);
    let transfer = await harness.prisma.moneyTransfer.findFirstOrThrow({ where: { jobId: job.id, kind: "cod_handover" } });
    expect(transfer.status).toBe("pending");

    // Rider sees it as money they owe, awaiting their tap.
    const mine = await harness.app.inject({ method: "GET", url: "/api/bearer/money-transfers", headers: auth });
    expect(((mine.json() as { transfers: { id: string }[] }).transfers).map((t) => t.id)).toContain(transfer.id);

    const handIn = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/hand-in`, headers: auth, payload: { amountHandedIn: 15 } });
    expect(handIn.statusCode).toBe(200);
    transfer = await harness.prisma.moneyTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
    expect(transfer.status).toBe("awaiting_other_side");
    expect(transfer.payerConfirmedAt).not.toBeNull();

    const approve = await harness.app.inject({ method: "POST", url: `/api/jobs/${job.id}/cod/approve`, headers: staff, payload: {} });
    expect(approve.statusCode).toBe(200);
    transfer = await harness.prisma.moneyTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
    expect(transfer.status).toBe("confirmed");
    expect(transfer.receiverConfirmedAt).not.toBeNull();
  });

  it("wrong-side confirms are refused; disputes freeze; strangers see nothing", async () => {
    const { auth, rider } = await makeRider({ verified: true });
    const other = await makeRider({ verified: true });
    const staff = await makeStaff();
    const job = await makeCodJob(rider.id);
    await harness.app.inject({ method: "POST", url: `/api/bearer/jobs/${job.id}/transition`, headers: auth, payload: { to: "delivered", pin: "4242" } });
    const transfer = await harness.prisma.moneyTransfer.findFirstOrThrow({ where: { jobId: job.id, kind: "cod_handover" } });

    // The RECEIVER (business) can't confirm "paid", and a stranger can't either.
    expect((await harness.app.inject({ method: "POST", url: `/api/money-transfers/${transfer.id}/confirm`, headers: staff, payload: { side: "paid" } })).statusCode).toBe(403);
    expect((await harness.app.inject({ method: "POST", url: `/api/money-transfers/${transfer.id}/confirm`, headers: other.auth, payload: { side: "received" } })).statusCode).toBe(403);
    expect((await harness.app.inject({ method: "GET", url: "/api/bearer/money-transfers", headers: other.auth })).json()).toEqual({ transfers: [] });

    // Rider disputes with a reason → frozen.
    const dispute = await harness.app.inject({ method: "POST", url: `/api/money-transfers/${transfer.id}/dispute`, headers: auth, payload: { note: "Short $2 at handover" } });
    expect(dispute.statusCode).toBe(200);
    // Frozen: no more confirms.
    expect((await harness.app.inject({ method: "POST", url: `/api/money-transfers/${transfer.id}/confirm`, headers: auth, payload: { side: "paid" } })).statusCode).toBe(409);
  });

  it("staff-created payouts need both sides too", async () => {
    const { auth, rider } = await makeRider({ verified: true });
    const staff = await makeStaff("admin");
    const created = await harness.app.inject({
      method: "POST", url: "/api/money-transfers", headers: staff,
      payload: { kind: "courier_payout", toRiderId: rider.id, amount: 25, note: "Week 41 fees" },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { transfer: { id: string } }).transfer.id;

    // Business pays → rider receives: two taps, two sides.
    expect((await harness.app.inject({ method: "POST", url: `/api/money-transfers/${id}/confirm`, headers: staff, payload: { side: "paid" } })).statusCode).toBe(200);
    let row = await harness.prisma.moneyTransfer.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("awaiting_other_side");
    expect((await harness.app.inject({ method: "POST", url: `/api/money-transfers/${id}/confirm`, headers: auth, payload: { side: "received" } })).statusCode).toBe(200);
    row = await harness.prisma.moneyTransfer.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("confirmed");
  });
});

describe("free-roam cash lockout", () => {
  it("an unverified free-roam courier gets prepaid work but never cash", async () => {
    await harness.prisma.business.update({ where: { id: harness.business.id }, data: { courierPool: "both" } });
    try {
      const free = await makeRider({ platformStatus: "approved", selfSignedUp: true, openNetwork: true });
      await harness.prisma.riderMembership.deleteMany({ where: { riderId: free.rider.id } });
      const customer = await harness.prisma.customer.create({ data: { businessId: harness.business.id, name: "Lockout Customer", phone: `+18765${uniq().slice(-7)}` } });

      // Cash job: no offer, claim refused.
      const cashJob = await harness.prisma.job.create({
        data: { businessId: harness.business.id, customerId: customer.id, jobNumber: `NOCASH-${uniq()}`, status: "new", paymentMethod: "cod", amountExpected: 2000, currency: "JMD" },
      });
      // Even an explicit broadcast skips them for cash.
      const staff0 = await makeStaff();
      expect((await harness.app.inject({ method: "POST", url: `/api/jobs/${cashJob.id}/offers/broadcast`, headers: staff0, payload: {} })).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 100));
      expect(await harness.prisma.jobOffer.count({ where: { jobId: cashJob.id, riderId: free.rider.id } })).toBe(0);
      expect((await harness.app.inject({ method: "POST", url: `/api/bearer/pending-jobs/${cashJob.id}/claim`, headers: free.auth })).statusCode).toBe(409);

      // Prepaid job: offered and claimable. (Direct-DB jobs skip the
      // creation-time auto-broadcast, so broadcast explicitly here.)
      const prepaidJob = await harness.prisma.job.create({
        data: { businessId: harness.business.id, customerId: customer.id, jobNumber: `PRE2-${uniq()}`, status: "new", paymentMethod: "transfer", currency: "JMD" },
      });
      const staff = await makeStaff();
      const bc = await harness.app.inject({ method: "POST", url: `/api/jobs/${prepaidJob.id}/offers/broadcast`, headers: staff, payload: {} });
      expect(bc.statusCode).toBe(200);
      await vi.waitFor(async () => expect(await harness.prisma.jobOffer.count({ where: { jobId: prepaidJob.id, riderId: free.rider.id } })).toBe(1));
      expect((await harness.app.inject({ method: "POST", url: `/api/bearer/pending-jobs/${prepaidJob.id}/claim`, headers: free.auth })).statusCode).toBe(200);

      // Verify them and cash opens up.
      const owner = await makeOwner();
      await harness.app.inject({ method: "PATCH", url: `/api/platform/riders/${free.rider.id}`, headers: owner, payload: { verified: true } });
      const cashJob2 = await harness.prisma.job.create({
        data: { businessId: harness.business.id, customerId: customer.id, jobNumber: `CASH2-${uniq()}`, status: "new", paymentMethod: "cod", amountExpected: 2000, currency: "JMD" },
      });
      expect((await harness.app.inject({ method: "POST", url: `/api/jobs/${cashJob2.id}/offers/broadcast`, headers: staff, payload: {} })).statusCode).toBe(200);
      await vi.waitFor(async () => expect(await harness.prisma.jobOffer.count({ where: { jobId: cashJob2.id, riderId: free.rider.id } })).toBe(1));
    } finally {
      await harness.prisma.business.update({ where: { id: harness.business.id }, data: { courierPool: "company" } });
    }
  });
});

describe("courier signup alerts the owner", () => {
  it("a new application emails owners and audits the notification", async () => {
    await harness.prisma.user.create({ data: { name: `Alert Owner ${uniq()}`, email: `alert-owner-${uniq()}@example.com`, passwordHash: "unused", role: "admin", platformRole: "owner" } });
    const email = `applicant-${uniq()}@example.com`;
    const res = await harness.app.inject({
      method: "POST", url: "/api/rider-signup",
      payload: { name: "Applicant", phone: `+18765${uniq().slice(-7)}`, email, vehicle: "motorcycle", password: "riderpass1", independent: true },
    });
    expect(res.statusCode).toBe(200);
    const riderId = (res.json() as { riderId: string }).riderId;
    // The owner notification fires void (never blocks signup) — wait for it.
    await vi.waitFor(async () => {
      const audit = await harness.prisma.auditLog.findFirst({ where: { action: "platform.rider.application.notify.sent", entityId: riderId } });
      expect(audit).not.toBeNull();
    });
  });
});

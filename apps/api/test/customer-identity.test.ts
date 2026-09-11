/**
 * Global customer identity (Stage 23 / spec section 6): real phone
 * normalization, verified-vs-provisional identities, and audited
 * duplicate resolution. Real Fastify app + real sqlite db (see
 * test/helpers/test-app.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { normalizePhone } from "../src/lib/phone.js";

let harness: TestHarness;
let businessB: { id: string; name: string };
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;
// The last 7 digits of uniq() (not the first, which barely change within a
// single test run) so every call actually produces a distinct 10-digit
// JM-shaped number — truncating the other way silently handed out the
// same "unique" phone repeatedly (Date.now()'s leading digits are nearly
// constant across a run), colliding across tests in ways that surfaced as
// 409s, wrong-code failures, and rate-limit 429s that looked unrelated.
const freshPhone = () => `876${uniq().slice(-7)}`;

async function staffToken(businessId: string, role: "admin" | "dispatcher" = "admin") {
  const user = await harness.prisma.user.create({ data: { name: `Staff ${uniq()}`, passwordHash: "unused-in-tests", role } });
  await harness.prisma.staffMembership.create({ data: { userId: user.id, businessId, role, active: true } });
  return harness.tokenFor({ id: user.id, name: user.name, role, businessId });
}

async function ownerToken() {
  const user = await harness.prisma.user.create({ data: { name: `Owner ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return harness.tokenFor({ id: user.id, name: user.name, role: "admin", platformRole: "owner" });
}

async function latestCode(phone: string): Promise<string> {
  const row = await harness.prisma.outboxMessage.findFirst({
    where: { template: "customer_dashboard_code", to: phone },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw new Error("no code was sent");
  return (row.params as { code: string }).code;
}

/** Returns the dashboard session token — most callers just discard it
 *  (they only care that the phone ends up verified), a couple need it to
 *  claim an account (Stage 25) afterward. */
async function verifyPhone(rawPhone: string): Promise<string> {
  const phone = normalizePhone(rawPhone)!;
  await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/request-code", payload: { phone: rawPhone } });
  const code = await latestCode(phone);
  const res = await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/verify", payload: { phone: rawPhone, code } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-customer-identity");
  businessB = await harness.prisma.business.create({ data: { name: "Identity Test Business B", slug: `identity-b-${Date.now()}` } });
});

afterAll(async () => {
  await harness.cleanup();
});

describe("automatic identity resolution", () => {
  it("creating a customer via the real API resolves a provisional identity automatically", async () => {
    const admin = await staffToken(harness.business.id);
    const phone = freshPhone();
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: "Identity Test Customer", phone },
    });
    expect(res.statusCode).toBe(200);
    const customerId = (res.json() as { customer: { id: string } }).customer.id;

    const row = await harness.prisma.customer.findUnique({ where: { id: customerId } });
    expect(row?.identityId).toBeTruthy();
    const identity = await harness.prisma.customerIdentity.findUnique({ where: { id: row!.identityId! } });
    expect(identity?.normalizedPhone).toBe(normalizePhone(phone));
    expect(identity?.status).toBe("provisional");
  });

  it("two different businesses' customers with the same phone share one identity, automatically — not a merge", async () => {
    const adminA = await staffToken(harness.business.id);
    const adminB = await staffToken(businessB.id);
    const phone = freshPhone();

    const resA = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${adminA}` },
      payload: { name: "Shared Person at A", phone },
    });
    const resB = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${adminB}` },
      payload: { name: "Shared Person at B", phone },
    });
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    const idA = (resA.json() as { customer: { id: string } }).customer.id;
    const idB = (resB.json() as { customer: { id: string } }).customer.id;
    const [rowA, rowB] = await Promise.all([
      harness.prisma.customer.findUnique({ where: { id: idA } }),
      harness.prisma.customer.findUnique({ where: { id: idB } }),
    ]);
    expect(rowA?.identityId).toBeTruthy();
    expect(rowA?.identityId).toBe(rowB?.identityId);
  });

  it("updating only a customer's name never touches their identity link; updating their phone re-resolves it", async () => {
    const admin = await staffToken(harness.business.id);
    const phone1 = freshPhone();
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: "Rename Me", phone: phone1 },
    });
    const customerId = (created.json() as { customer: { id: string } }).customer.id;
    const before = await harness.prisma.customer.findUnique({ where: { id: customerId } });

    await harness.app.inject({
      method: "PATCH",
      url: `/api/customers/${customerId}`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: "Renamed" },
    });
    const afterNameChange = await harness.prisma.customer.findUnique({ where: { id: customerId } });
    expect(afterNameChange?.identityId).toBe(before?.identityId);

    const phone2 = freshPhone();
    await harness.app.inject({
      method: "PATCH",
      url: `/api/customers/${customerId}`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { phone: phone2 },
    });
    const afterPhoneChange = await harness.prisma.customer.findUnique({ where: { id: customerId } });
    expect(afterPhoneChange?.identityId).toBeTruthy();
    expect(afterPhoneChange?.identityId).not.toBe(before?.identityId);
    const newIdentity = await harness.prisma.customerIdentity.findUnique({ where: { id: afterPhoneChange!.identityId! } });
    expect(newIdentity?.normalizedPhone).toBe(normalizePhone(phone2));
  });
});

describe("verified vs provisional", () => {
  it("a phone starts provisional and only becomes verified through the customer-dashboard OTP flow", async () => {
    const admin = await staffToken(harness.business.id);
    const phone = freshPhone();
    await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: "Provisional Then Verified", phone },
    });
    const before = await harness.prisma.customerIdentity.findUnique({ where: { normalizedPhone: normalizePhone(phone)! } });
    expect(before?.status).toBe("provisional");

    await verifyPhone(phone);
    const after = await harness.prisma.customerIdentity.findUnique({ where: { normalizedPhone: normalizePhone(phone)! } });
    expect(after?.status).toBe("verified");
    expect(after?.verifiedAt).toBeTruthy();
  });

  it("a later provisional-looking write for an already-verified phone never downgrades it", async () => {
    const phone = freshPhone();
    await verifyPhone(phone);

    const admin = await staffToken(harness.business.id);
    await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: "Joins An Already-Verified Identity", phone },
    });
    const identity = await harness.prisma.customerIdentity.findUnique({ where: { normalizedPhone: normalizePhone(phone)! } });
    expect(identity?.status).toBe("verified");
  });
});

describe("audited duplicate resolution (owner-only)", () => {
  it("a non-owner staff member cannot list duplicate candidates or merge identities", async () => {
    const admin = await staffToken(harness.business.id);
    const list = await harness.app.inject({ method: "GET", url: "/api/owner/customer-identities/duplicates", headers: { authorization: `Bearer ${admin}` } });
    expect(list.statusCode).toBe(403);
    const merge = await harness.app.inject({
      method: "POST",
      url: "/api/owner/customer-identities/x/merge",
      headers: { authorization: `Bearer ${admin}` },
      payload: { intoId: "y" },
    });
    expect(merge.statusCode).toBe(403);
  });

  it("surfaces two identities sharing an email as duplicate candidates, and an owner can merge them with a full audit trail", async () => {
    const adminA = await staffToken(harness.business.id);
    const adminB = await staffToken(businessB.id);
    const sharedEmail = `same.person.${uniq()}@example.com`;
    const phone1 = freshPhone();
    const phone2 = freshPhone();

    const resA = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${adminA}` },
      payload: { name: "Same Person (phone 1)", phone: phone1, email: sharedEmail },
    });
    await verifyPhone(phone1); // this one gets proven

    const resB = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${adminB}` },
      payload: { name: "Same Person (phone 2)", phone: phone2, email: sharedEmail },
    });

    const custA = (resA.json() as { customer: { id: string } }).customer.id;
    const custB = (resB.json() as { customer: { id: string } }).customer.id;
    const [rowA, rowB] = await Promise.all([
      harness.prisma.customer.findUnique({ where: { id: custA } }),
      harness.prisma.customer.findUnique({ where: { id: custB } }),
    ]);
    const identityA = rowA!.identityId!;
    const identityB = rowB!.identityId!;
    expect(identityA).not.toBe(identityB); // different phones -> not auto-merged

    const owner = await ownerToken();
    const candidates = await harness.app.inject({ method: "GET", url: "/api/owner/customer-identities/duplicates", headers: { authorization: `Bearer ${owner}` } });
    expect(candidates.statusCode).toBe(200);
    const groups = (candidates.json() as { candidates: { normalizedEmail: string; identities: { id: string }[] }[] }).candidates;
    const group = groups.find((g) => g.normalizedEmail === sharedEmail);
    expect(group).toBeTruthy();
    expect(group!.identities.map((i) => i.id).sort()).toEqual([identityA, identityB].sort());

    const merge = await harness.app.inject({
      method: "POST",
      url: `/api/owner/customer-identities/${identityB}/merge`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { intoId: identityA, reason: "confirmed same person, two phones" },
    });
    expect(merge.statusCode).toBe(200);

    // Both Customer rows now point at the surviving identity...
    const [afterA, afterB] = await Promise.all([
      harness.prisma.customer.findUnique({ where: { id: custA } }),
      harness.prisma.customer.findUnique({ where: { id: custB } }),
    ]);
    expect(afterA?.identityId).toBe(identityA);
    expect(afterB?.identityId).toBe(identityA);

    // ...trust already proven survives the merge (phone1 was verified)...
    const merged = await harness.prisma.customerIdentity.findUnique({ where: { id: identityA } });
    expect(merged?.status).toBe("verified");

    // ...the merged-away identity is gone...
    const gone = await harness.prisma.customerIdentity.findUnique({ where: { id: identityB } });
    expect(gone).toBeNull();

    // ...but its own phone still resolves to the survivor, forever after —
    // a THIRD business's customer using phone2 lands on the same identity,
    // not a freshly re-created one.
    const adminC = await staffToken((await harness.prisma.business.create({ data: { name: "Identity Test Business C", slug: `identity-c-${Date.now()}` } })).id);
    const resC = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${adminC}` },
      payload: { name: "Same Person (phone 2, again)", phone: phone2 },
    });
    const custC = (resC.json() as { customer: { id: string } }).customer.id;
    const rowC = await harness.prisma.customer.findUnique({ where: { id: custC } });
    expect(rowC?.identityId).toBe(identityA);

    // ...and the whole thing is audited.
    const auditRow = await harness.prisma.auditLog.findFirst({ where: { action: "customerIdentity.merge", entityId: identityA }, orderBy: { at: "desc" } });
    expect(auditRow).toBeTruthy();
    expect((auditRow!.meta as { mergedFromId: string }).mergedFromId).toBe(identityB);
  });

  it("refuses to merge an identity into itself, and 404s on an unknown id", async () => {
    const owner = await ownerToken();
    const phone = freshPhone();
    await verifyPhone(phone);
    const identity = await harness.prisma.customerIdentity.findUnique({ where: { normalizedPhone: normalizePhone(phone)! } });

    const selfMerge = await harness.app.inject({
      method: "POST",
      url: `/api/owner/customer-identities/${identity!.id}/merge`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { intoId: identity!.id },
    });
    expect(selfMerge.statusCode).toBe(400);

    const unknown = await harness.app.inject({
      method: "POST",
      url: `/api/owner/customer-identities/${identity!.id}/merge`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { intoId: "does-not-exist" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  // Stage 28's cross-stage review: CustomerAccount (Stage 25) didn't exist
  // when the merge logic above was written (Stage 23), and its
  // identityId relation cascade-deletes on the identity it points to —
  // merging away an identity that had a real account would have silently
  // destroyed that customer's login credentials with no warning at all.
  it("carries a claimed account over to the surviving identity on merge, rather than losing it to the cascade", async () => {
    const owner = await ownerToken();
    const sourcePhone = freshPhone();
    const targetPhone = freshPhone();
    const sourceToken = await verifyPhone(sourcePhone);
    await verifyPhone(targetPhone);
    const email = `merge-account-${uniq()}@example.com`;
    const claim = await harness.app.inject({
      method: "POST",
      url: "/api/customer-account/claim",
      headers: { authorization: `Bearer ${sourceToken}` },
      payload: { email, password: "correcthorsebattery" },
    });
    expect(claim.statusCode).toBe(200);

    const sourceIdentity = await harness.prisma.customerIdentity.findUnique({ where: { normalizedPhone: normalizePhone(sourcePhone)! } });
    const targetIdentity = await harness.prisma.customerIdentity.findUnique({ where: { normalizedPhone: normalizePhone(targetPhone)! } });

    const merge = await harness.app.inject({
      method: "POST",
      url: `/api/owner/customer-identities/${sourceIdentity!.id}/merge`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { intoId: targetIdentity!.id },
    });
    expect(merge.statusCode).toBe(200);

    // The account still exists, still logs in, and now belongs to the
    // surviving identity — never cascade-deleted with the source.
    const account = await harness.prisma.customerAccount.findUnique({ where: { email } });
    expect(account).toBeTruthy();
    expect(account!.identityId).toBe(targetIdentity!.id);
    const login = await harness.app.inject({ method: "POST", url: "/api/customer-account/login", payload: { email, password: "correcthorsebattery" } });
    expect(login.statusCode).toBe(200);
  });

  it("refuses to merge two identities that each independently claimed their own account", async () => {
    const owner = await ownerToken();
    const phoneA = freshPhone();
    const phoneB = freshPhone();
    const tokenA = await verifyPhone(phoneA);
    const tokenB = await verifyPhone(phoneB);
    await harness.app.inject({
      method: "POST",
      url: "/api/customer-account/claim",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { email: `merge-conflict-a-${uniq()}@example.com`, password: "correcthorsebattery" },
    });
    await harness.app.inject({
      method: "POST",
      url: "/api/customer-account/claim",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { email: `merge-conflict-b-${uniq()}@example.com`, password: "correcthorsebattery" },
    });
    const identityA = await harness.prisma.customerIdentity.findUnique({ where: { normalizedPhone: normalizePhone(phoneA)! } });
    const identityB = await harness.prisma.customerIdentity.findUnique({ where: { normalizedPhone: normalizePhone(phoneB)! } });

    const merge = await harness.app.inject({
      method: "POST",
      url: `/api/owner/customer-identities/${identityA!.id}/merge`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { intoId: identityB!.id },
    });
    expect(merge.statusCode).toBe(409);

    // Nothing was touched — both identities and both accounts still exist, untouched.
    expect(await harness.prisma.customerIdentity.findUnique({ where: { id: identityA!.id } })).toBeTruthy();
    expect(await harness.prisma.customerIdentity.findUnique({ where: { id: identityB!.id } })).toBeTruthy();
    expect(await harness.prisma.customerAccount.findUnique({ where: { identityId: identityA!.id } })).toBeTruthy();
    expect(await harness.prisma.customerAccount.findUnique({ where: { identityId: identityB!.id } })).toBeTruthy();
  });
});

describe("audit log business isolation", () => {
  it("a business only sees its own audit entries; the platform owner sees every business's", async () => {
    const adminA = await staffToken(harness.business.id);
    const adminB = await staffToken(businessB.id);
    const owner = await ownerToken();

    const createA = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${adminA}` },
      payload: { name: "Audit Isolation A", phone: freshPhone() },
    });
    const createB = await harness.app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${adminB}` },
      payload: { name: "Audit Isolation B", phone: freshPhone() },
    });
    const idA = (createA.json() as { customer: { id: string } }).customer.id;
    const idB = (createB.json() as { customer: { id: string } }).customer.id;

    const listA = await harness.app.inject({ method: "GET", url: "/api/audit?take=500", headers: { authorization: `Bearer ${adminA}` } });
    const entityIdsA = (listA.json() as { entries: { entityId: string | null }[] }).entries.map((e) => e.entityId);
    expect(entityIdsA).toContain(idA);
    expect(entityIdsA).not.toContain(idB);

    const listB = await harness.app.inject({ method: "GET", url: "/api/audit?take=500", headers: { authorization: `Bearer ${adminB}` } });
    const entityIdsB = (listB.json() as { entries: { entityId: string | null }[] }).entries.map((e) => e.entityId);
    expect(entityIdsB).toContain(idB);
    expect(entityIdsB).not.toContain(idA);

    const listOwner = await harness.app.inject({ method: "GET", url: "/api/owner/audit?take=500", headers: { authorization: `Bearer ${owner}` } });
    const entityIdsOwner = (listOwner.json() as { entries: { entityId: string | null }[] }).entries.map((e) => e.entityId);
    expect(entityIdsOwner).toContain(idA);
    expect(entityIdsOwner).toContain(idB);
  });

  it("a non-owner cannot reach the platform-wide audit route", async () => {
    const admin = await staffToken(harness.business.id);
    const res = await harness.app.inject({ method: "GET", url: "/api/owner/audit", headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * A merchant's own login (spec: "a merchant should have a login where
 * they can view [their orders] as well"). Its own auth "face" — a
 * merchant_portal JWT, not a staff access token — so the real test here
 * isn't just "login works", it's isolation: a merchant sees only its own
 * orders, never another merchant's, and never anything at all without a
 * valid token.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function adminToken(h: TestHarness, businessId = h.business.id) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId });
}

async function ownerToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Owner ${uniq()}`, passwordHash: "unused-in-tests", role: "admin", platformRole: "owner" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", platformRole: "owner" });
}

async function makeMerchant(h: TestHarness, auth: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/merchants",
    headers: { authorization: `Bearer ${auth}` },
    payload: { name: `VBR Basics ${uniq()}`, notificationEmails: "owner@vbr.example" },
  });
  return (res.json() as { merchant: { id: string; slug: string } }).merchant;
}

async function placeOrder(h: TestHarness, merchantSlug: string) {
  const res = await h.app.inject({
    method: "POST",
    url: `/api/order/${merchantSlug}`,
    payload: {
      name: `Customer ${uniq()}`,
      phone: `+1876555${uniq().slice(-4)}`,
      point: { lat: 18.0, lng: -76.8 },
      addressText: "3 Constant Spring Road, Kingston",
      items: [{ name: "hot dog", quantity: 1, unitPrice: 900 }],
    },
  });
  return res.json() as { jobId: string; jobNumber: string };
}

beforeAll(async () => {
  harness = await buildTestHarness("test-merchant-portal");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("merchant portal", () => {
  it("supports public merchant signup, email verification, approval, and portal login", async () => {
    const publicBusiness = await harness.prisma.business.create({ data: { name: "Public Dispatch", slug: "ronmacrae" } });
    // A platform-owner account with an email set — notifyOwnersOfApplication
    // (fired at signup time) only has somewhere to send to when one exists;
    // ownerToken() deliberately omits email so other tests here don't pick
    // up a stray notification.
    await harness.prisma.user.create({ data: { name: "Notified Owner", email: `notify-owner-${uniq()}@example.com`, passwordHash: "unused-in-tests", role: "admin", platformRole: "owner", active: true } });
    const email = `new-owner-${uniq()}@vbr.example`;
    const signup = await harness.app.inject({
      method: "POST",
      url: "/api/merchant-signup",
      payload: { ownerName: "New Owner", businessName: `New Store ${uniq()}`, email, phone: `+187655${uniq().slice(-5)}`, pickupAddressText: "Kingston", password: "securepass1" },
    });
    expect(signup.statusCode).toBe(200);
    const { merchantId } = signup.json() as { merchantId: string };
    const sent = (harness.ctx.email as unknown as { sent: { to: string; text: string }[] }).sent.find((m) => m.to === email);
    const code = sent?.text.match(/code is (\d+)/)?.[1];
    expect(code).toBeTruthy();

    const verify = await harness.app.inject({ method: "POST", url: "/api/merchant-signup/verify", payload: { email, code } });
    expect(verify.statusCode).toBe(200);
    const beforeApproval = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email, password: "securepass1" } });
    expect(beforeApproval.statusCode).toBe(403);

    const owner = await adminToken(harness, publicBusiness.id);
    const approve = await harness.app.inject({ method: "PATCH", url: `/api/platform/merchants/${merchantId}`, headers: { authorization: `Bearer ${owner}` }, payload: { active: true } });
    expect(approve.statusCode).toBe(403);
    // Business admins approve merchant applications in their own business by
    // activating the existing merchant record through the staff route.
    const staffApprove = await harness.app.inject({ method: "PATCH", url: `/api/merchants/${merchantId}`, headers: { authorization: `Bearer ${owner}` }, payload: { active: true } });
    expect(staffApprove.statusCode).toBe(200);
    const login = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email, password: "securepass1" } });
    expect(login.statusCode).toBe(200);

    // Platform Admin was notified of the application (spec: "notify the
    // platform admin") — best-effort, but the memory provider lets us
    // confirm it was actually attempted.
    const notifyEmail = (harness.ctx.email as unknown as { sent: { subject: string; text: string }[] }).sent.find((m) => m.subject.includes("merchant application"));
    expect(notifyEmail).toBeTruthy();
    expect(notifyEmail?.text).toContain(email);
  });

  it("Platform Admin can reject a pending merchant application with a reason — distinct from a plain disable — and login stays refused", async () => {
    await harness.prisma.business.upsert({ where: { slug: "ronmacrae" }, create: { name: "Public Dispatch", slug: "ronmacrae" }, update: {} });
    const email = `rejected-owner-${uniq()}@vbr.example`;
    const signup = await harness.app.inject({
      method: "POST",
      url: "/api/merchant-signup",
      payload: { ownerName: "Rejected Owner", businessName: `Sketchy Store ${uniq()}`, email, phone: `+187655${uniq().slice(-5)}`, pickupAddressText: "Kingston", password: "securepass1" },
    });
    const { merchantId } = signup.json() as { merchantId: string };
    const sent = (harness.ctx.email as unknown as { sent: { to: string; text: string }[] }).sent.find((m) => m.to === email);
    const code = sent?.text.match(/code is (\d+)/)?.[1];
    await harness.app.inject({ method: "POST", url: "/api/merchant-signup/verify", payload: { email, code } });

    const owner = await ownerToken(harness);

    const missingReason = await harness.app.inject({ method: "POST", url: `/api/platform/merchants/${merchantId}/review`, headers: { authorization: `Bearer ${owner}` }, payload: { decision: "reject" } });
    expect(missingReason.statusCode).toBe(400);

    const reject = await harness.app.inject({
      method: "POST",
      url: `/api/platform/merchants/${merchantId}/review`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { decision: "reject", reason: "Duplicate of an existing store" },
    });
    expect(reject.statusCode).toBe(200);
    expect((reject.json() as { applicationStatus: string }).applicationStatus).toBe("rejected");

    const row = await harness.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect(row.applicationStatus).toBe("rejected");
    expect(row.rejectionReason).toBe("Duplicate of an existing store");
    expect(row.active).toBe(false);

    const login = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email, password: "securepass1" } });
    expect(login.statusCode).toBe(403);

    const reReview = await harness.app.inject({ method: "POST", url: `/api/platform/merchants/${merchantId}/review`, headers: { authorization: `Bearer ${owner}` }, payload: { decision: "approve" } });
    expect(reReview.statusCode).toBe(409);
  });

  it("disabled access after approval is refused the same way as a never-approved application", async () => {
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const email = `disabled-owner-${uniq()}@vbr.example`;
    const password = "securepass1";
    const grant = await harness.app.inject({ method: "POST", url: `/api/merchants/${merchant.id}/staff`, headers: { authorization: `Bearer ${admin}` }, payload: { email, password } });
    expect(grant.statusCode).toBe(200);

    const loginWorks = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email, password } });
    expect(loginWorks.statusCode).toBe(200);

    const disable = await harness.app.inject({ method: "PATCH", url: `/api/merchants/${merchant.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { active: false } });
    expect(disable.statusCode).toBe(200);

    const loginAfterDisable = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email, password } });
    expect(loginAfterDisable.statusCode).toBe(403);
  });

  it("logs in with granted credentials, and sees only its own merchant's orders", async () => {
    const admin = await adminToken(harness);
    const merchantA = await makeMerchant(harness, admin);
    const merchantB = await makeMerchant(harness, admin);
    const email = `owner-${uniq()}@vbr.example`;

    const grant = await harness.app.inject({
      method: "POST",
      url: `/api/merchants/${merchantA.id}/staff`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { email, name: "VBR Owner", password: "merchantpass1" },
    });
    expect(grant.statusCode).toBe(200);

    const badLogin = await harness.app.inject({
      method: "POST",
      url: "/api/merchant-portal/login",
      payload: { email, password: "wrong-password" },
    });
    expect(badLogin.statusCode).toBe(401);

    const login = await harness.app.inject({
      method: "POST",
      url: "/api/merchant-portal/login",
      payload: { email, password: "merchantpass1" },
    });
    expect(login.statusCode).toBe(200);
    const { token, merchant } = login.json() as { token: string; merchant: { id: string; name: string } };
    expect(merchant.id).toBe(merchantA.id);

    // No token at all -> refused.
    const noAuth = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/orders" });
    expect(noAuth.statusCode).toBe(401);

    const orderA = await placeOrder(harness, merchantA.slug);
    const orderB = await placeOrder(harness, merchantB.slug);

    const orders = await harness.app.inject({
      method: "GET",
      url: "/api/merchant-portal/orders",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(orders.statusCode).toBe(200);
    const { orders: list } = orders.json() as { orders: { id: string; jobNumber: string }[] };
    expect(list.some((o) => o.id === orderA.jobId)).toBe(true);
    // The real point of this test: merchant B's order must never appear here.
    expect(list.some((o) => o.id === orderB.jobId)).toBe(false);

    const me = await harness.app.inject({
      method: "GET",
      url: "/api/merchant-portal/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { merchant: { id: string } }).merchant.id).toBe(merchantA.id);
  });

  it("a staff access token cannot be used against the merchant-portal routes", async () => {
    const admin = await adminToken(harness);
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/merchant-portal/orders",
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("manages its own catalog, and can never touch another merchant's product", async () => {
    const admin = await adminToken(harness);
    const merchantA = await makeMerchant(harness, admin);
    const merchantB = await makeMerchant(harness, admin);

    async function portalToken(merchantId: string): Promise<string> {
      const email = `owner-${uniq()}@vbr.example`;
      await harness.app.inject({
        method: "POST",
        url: `/api/merchants/${merchantId}/staff`,
        headers: { authorization: `Bearer ${admin}` },
        payload: { email, password: "merchantpass1" },
      });
      const login = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/login", payload: { email, password: "merchantpass1" } });
      return (login.json() as { token: string }).token;
    }
    const tokenA = await portalToken(merchantA.id);
    const tokenB = await portalToken(merchantB.id);

    const create = await harness.app.inject({
      method: "POST",
      url: "/api/merchant-portal/products",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: "Black bomber jacket", price: 4500 },
    });
    expect(create.statusCode).toBe(200);
    const { product } = create.json() as { product: { id: string; name: string } };

    const listA = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/products", headers: { authorization: `Bearer ${tokenA}` } });
    expect((listA.json() as { products: { id: string }[] }).products.some((p) => p.id === product.id)).toBe(true);

    // Merchant B's own (empty) catalog never shows merchant A's product.
    const listB = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/products", headers: { authorization: `Bearer ${tokenB}` } });
    expect((listB.json() as { products: { id: string }[] }).products.some((p) => p.id === product.id)).toBe(false);

    // Merchant B cannot edit or delete merchant A's product — 404, not 403,
    // same "don't confirm it exists" discipline as everywhere else.
    const crossEdit = await harness.app.inject({
      method: "PATCH",
      url: `/api/merchant-portal/products/${product.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: "Hijacked name" },
    });
    expect(crossEdit.statusCode).toBe(404);
    const crossDelete = await harness.app.inject({
      method: "DELETE",
      url: `/api/merchant-portal/products/${product.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(crossDelete.statusCode).toBe(404);

    // Merchant A can edit its own product.
    const edit = await harness.app.inject({
      method: "PATCH",
      url: `/api/merchant-portal/products/${product.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { price: 5000 },
    });
    expect(edit.statusCode).toBe(200);
    expect((edit.json() as { product: { price: { amount: number } } }).product.price.amount).toBe(5000);

    const del = await harness.app.inject({
      method: "DELETE",
      url: `/api/merchant-portal/products/${product.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(del.statusCode).toBe(200);
  });
});

describe("merchant portal: courier roster", () => {
  // Mints a merchant-portal token directly (rather than hitting the
  // rate-limited login endpoint) — the login flow itself is already covered
  // above; these tests are about the rider routes' authorization, which only
  // checks the token's merchantId via verifyMerchantPortal.
  async function portalToken(h: TestHarness, merchantId: string): Promise<string> {
    const user = await h.prisma.user.create({ data: { name: `Owner ${uniq()}`, email: `owner-${uniq()}@vbr.example`, passwordHash: "unused-in-tests", emailVerifiedAt: new Date() } });
    await h.prisma.merchantStaff.create({ data: { userId: user.id, merchantId, active: true } });
    return h.jwt.issueMerchantPortal(user.id, merchantId);
  }

  async function makeRider(h: TestHarness, auth: string, phone?: string) {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/riders",
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: `Rider ${uniq()}`, phone: phone ?? `+1876555${uniq().slice(-4)}` },
    });
    return (res.json() as { rider: { id: string; phone: string } }).rider;
  }

  it("adds, lists, and removes its own couriers without touching the rider account or another merchant's roster", async () => {
    const admin = await adminToken(harness);
    const merchantA = await makeMerchant(harness, admin);
    const merchantB = await makeMerchant(harness, admin);
    const riderA = await makeRider(harness, admin);
    const tokenA = await portalToken(harness, merchantA.id);
    const tokenB = await portalToken(harness, merchantB.id);

    // Starts empty.
    const empty = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${tokenA}` } });
    expect((empty.json() as { riders: unknown[] }).riders).toHaveLength(0);

    // Add by riderId.
    const add = await harness.app.inject({
      method: "POST",
      url: "/api/merchant-portal/riders",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { riderId: riderA.id },
    });
    expect(add.statusCode).toBe(200);
    expect((add.json() as { rider: { id: string } }).rider.id).toBe(riderA.id);

    // Now listed for A.
    const listA = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${tokenA}` } });
    expect((listA.json() as { riders: { id: string }[] }).riders.some((r) => r.id === riderA.id)).toBe(true);

    // Search surfaces it as already attached.
    const search = await harness.app.inject({ method: "GET", url: `/api/merchant-portal/riders/search?q=${encodeURIComponent(riderA.phone)}`, headers: { authorization: `Bearer ${tokenA}` } });
    const searchRow = (search.json() as { riders: { id: string; alreadyAttached: boolean }[] }).riders.find((r) => r.id === riderA.id);
    expect(searchRow?.alreadyAttached).toBe(true);

    // Duplicate add is refused, not silently duplicated.
    const dup = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${tokenA}` }, payload: { riderId: riderA.id } });
    expect(dup.statusCode).toBe(409);

    // Merchant B never sees A's courier.
    const listB = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${tokenB}` } });
    expect((listB.json() as { riders: { id: string }[] }).riders.some((r) => r.id === riderA.id)).toBe(false);

    // Remove from A — relationship gone, account still exists.
    const remove = await harness.app.inject({ method: "DELETE", url: `/api/merchant-portal/riders/${riderA.id}`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(remove.statusCode).toBe(200);
    const afterRemove = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${tokenA}` } });
    expect((afterRemove.json() as { riders: { id: string }[] }).riders.some((r) => r.id === riderA.id)).toBe(false);
    expect(await harness.prisma.rider.findUnique({ where: { id: riderA.id } })).not.toBeNull();

    // Removing again (not attached) is a 404.
    const removeAgain = await harness.app.inject({ method: "DELETE", url: `/api/merchant-portal/riders/${riderA.id}`, headers: { authorization: `Bearer ${tokenA}` } });
    expect(removeAgain.statusCode).toBe(404);

    // Re-add works (reactivates the soft-removed relationship).
    const readd = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${tokenA}` }, payload: { riderId: riderA.id } });
    expect(readd.statusCode).toBe(200);
    const rel = await harness.prisma.merchantRider.findUniqueOrThrow({ where: { merchantId_riderId: { merchantId: merchantA.id, riderId: riderA.id } } });
    expect(rel.status).toBe("active");
  });

  it("adds a courier by phone number and by email", async () => {
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const token = await portalToken(harness, merchant.id);

    // Rider without a login (phone only) — add by phone.
    const phoneRider = await makeRider(harness, admin);
    const byPhone = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${token}` }, payload: { phone: phoneRider.phone } });
    expect(byPhone.statusCode).toBe(200);

    // Rider with a login — add by email (resolves via Rider.user.email).
    const email = `rider-${uniq()}@vbr.example`;
    const createWithLogin = await harness.app.inject({
      method: "POST",
      url: "/api/riders",
      headers: { authorization: `Bearer ${admin}` },
      payload: { name: `Rider ${uniq()}`, phone: `+1876555${uniq().slice(-4)}`, email, password: "riderpass1" },
    });
    expect(createWithLogin.statusCode).toBe(200);
    const byEmail = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${token}` }, payload: { email } });
    expect(byEmail.statusCode).toBe(200);

    // Unknown reference is a 404.
    const unknown = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${token}` }, payload: { phone: "+18769999999" } });
    expect(unknown.statusCode).toBe(404);
  });

  it("a merchant cannot remove a courier it is not attached to", async () => {
    const admin = await adminToken(harness);
    const merchantA = await makeMerchant(harness, admin);
    const merchantB = await makeMerchant(harness, admin);
    const rider = await makeRider(harness, admin);
    const tokenB = await portalToken(harness, merchantB.id);

    // Attach to A only.
    const tokenA = await portalToken(harness, merchantA.id);
    const addA = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${tokenA}` }, payload: { riderId: rider.id } });
    expect(addA.statusCode).toBe(200);

    // B cannot remove A's relationship.
    const crossRemove = await harness.app.inject({ method: "DELETE", url: `/api/merchant-portal/riders/${rider.id}`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(crossRemove.statusCode).toBe(404);
    const rel = await harness.prisma.merchantRider.findUniqueOrThrow({ where: { merchantId_riderId: { merchantId: merchantA.id, riderId: rider.id } } });
    expect(rel.status).toBe("active");
  });

  // Stage D (spec: "a courier can attach to multiple merchants only after
  // Platform Admin approval or authorized business assignment"): a merchant
  // may only search for and attach couriers who are already active members
  // of its OWN business — never an arbitrary rider elsewhere on the
  // platform. Uses a second Business row in the same harness, not a second
  // harness (a second buildTestHarness call corrupts the shared
  // DATABASE_URL — see this suite's own established convention).
  it("search and add are scoped to the merchant's own business — a rider with no membership there is invisible and unattachable", async () => {
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const token = await portalToken(harness, merchant.id);

    const otherBusiness = await harness.prisma.business.create({ data: { name: `Unrelated Courier Co ${uniq()}`, slug: `unrelated-${uniq()}` } });
    const outsideRider = await harness.prisma.rider.create({ data: { name: `Outside Rider ${uniq()}`, phone: `+1876576${uniq().slice(-4)}`, active: true, status: "available" } });
    // The harness's own rider.create() hook auto-creates an active
    // RiderMembership at harness.business.id for every rider — remove it
    // so this rider genuinely has no relationship with the merchant's
    // business yet, only with otherBusiness.
    await harness.prisma.riderMembership.deleteMany({ where: { riderId: outsideRider.id, businessId: harness.business.id } });
    await harness.prisma.riderMembership.create({ data: { riderId: outsideRider.id, businessId: otherBusiness.id, status: "active", approvedAt: new Date() } });

    // Invisible to search, even by exact phone.
    const search = await harness.app.inject({ method: "GET", url: `/api/merchant-portal/riders/search?q=${encodeURIComponent(outsideRider.phone)}`, headers: { authorization: `Bearer ${token}` } });
    expect((search.json() as { riders: { id: string }[] }).riders.some((r) => r.id === outsideRider.id)).toBe(false);

    // Cannot be attached by riderId, phone, or a matching login email either.
    const byId = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${token}` }, payload: { riderId: outsideRider.id } });
    expect(byId.statusCode).toBe(404);
    const byPhone = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${token}` }, payload: { phone: outsideRider.phone } });
    expect(byPhone.statusCode).toBe(404);
    expect(await harness.prisma.merchantRider.findUnique({ where: { merchantId_riderId: { merchantId: merchant.id, riderId: outsideRider.id } } })).toBeNull();

    // The same rider, once actively a member of the merchant's own
    // business, becomes findable and attachable — proves this is a real
    // scoping rule, not a rider that's broken some other way.
    await harness.prisma.riderMembership.create({ data: { riderId: outsideRider.id, businessId: harness.business.id, status: "active", approvedAt: new Date() } });
    const searchAfter = await harness.app.inject({ method: "GET", url: `/api/merchant-portal/riders/search?q=${encodeURIComponent(outsideRider.phone)}`, headers: { authorization: `Bearer ${token}` } });
    expect((searchAfter.json() as { riders: { id: string }[] }).riders.some((r) => r.id === outsideRider.id)).toBe(true);
    const addAfter = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${token}` }, payload: { riderId: outsideRider.id } });
    expect(addAfter.statusCode).toBe(200);
  });
});

describe("merchant portal: book delivery", () => {
  async function portalToken(h: TestHarness, merchantId: string): Promise<string> {
    const user = await h.prisma.user.create({ data: { name: `Owner ${uniq()}`, email: `owner-${uniq()}@vbr.example`, passwordHash: "unused-in-tests", emailVerifiedAt: new Date() } });
    await h.prisma.merchantStaff.create({ data: { userId: user.id, merchantId, active: true } });
    return h.jwt.issueMerchantPortal(user.id, merchantId);
  }

  async function makeRider(h: TestHarness, auth: string) {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/riders",
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: `Rider ${uniq()}`, phone: `+1876555${uniq().slice(-4)}` },
    });
    return (res.json() as { rider: { id: string } }).rider;
  }

  it("books a delivery, saves a free-text item to its catalog (deduped), and assigns its own courier", async () => {
    const admin = await adminToken(harness);
    const merchant = await makeMerchant(harness, admin);
    const token = await portalToken(harness, merchant.id);
    const rider = await makeRider(harness, admin);

    // Attach the courier to this merchant (roster).
    const attach = await harness.app.inject({ method: "POST", url: "/api/merchant-portal/riders", headers: { authorization: `Bearer ${token}` }, payload: { riderId: rider.id } });
    expect(attach.statusCode).toBe(200);

    // Book a delivery with a free-text item marked saveToCatalog.
    const book = await harness.app.inject({
      method: "POST",
      url: "/api/merchant-portal/orders",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        customerName: "Test Customer",
        customerPhone: "+18765550001",
        addressText: "9 Hope Road, Kingston",
        items: [{ name: "Hydraulic Salon Chair", quantity: 1, unitPrice: 4500, saveToCatalog: true }],
      },
    });
    expect(book.statusCode).toBe(200);
    const { jobId } = book.json() as { jobId: string };

    // Item now exists in this merchant's catalog.
    const catalog = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/products", headers: { authorization: `Bearer ${token}` } });
    const names = (catalog.json() as { products: { name: string }[] }).products.map((p) => p.name);
    expect(names.filter((n) => n === "Hydraulic Salon Chair")).toHaveLength(1);

    // Booking the SAME item again does not duplicate the catalog entry.
    await harness.app.inject({
      method: "POST",
      url: "/api/merchant-portal/orders",
      headers: { authorization: `Bearer ${token}` },
      payload: { customerName: "Test Customer 2", customerPhone: "+18765550002", addressText: "10 Hope Road, Kingston", items: [{ name: "Hydraulic Salon Chair", quantity: 1, unitPrice: 4500, saveToCatalog: true }] },
    });
    const catalog2 = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/products", headers: { authorization: `Bearer ${token}` } });
    const names2 = (catalog2.json() as { products: { name: string }[] }).products.map((p) => p.name);
    expect(names2.filter((n) => n === "Hydraulic Salon Chair")).toHaveLength(1);

    // Order is listed for this merchant, and is unassigned.
    const orders = await harness.app.inject({ method: "GET", url: "/api/merchant-portal/orders", headers: { authorization: `Bearer ${token}` } });
    expect((orders.json() as { orders: { id: string }[] }).orders.some((o) => o.id === jobId)).toBe(true);

    // Assign its own courier.
    const assign = await harness.app.inject({ method: "POST", url: `/api/merchant-portal/orders/${jobId}/assign`, headers: { authorization: `Bearer ${token}` }, payload: { riderId: rider.id } });
    expect(assign.statusCode).toBe(200);
    const job = await harness.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.riderId).toBe(rider.id);
    expect(job.status).toBe("assigned");
  });

  it("cannot assign a courier outside its roster, nor touch another merchant's order", async () => {
    const admin = await adminToken(harness);
    const merchantA = await makeMerchant(harness, admin);
    const merchantB = await makeMerchant(harness, admin);
    const tokenA = await portalToken(harness, merchantA.id);
    const tokenB = await portalToken(harness, merchantB.id);
    const rider = await makeRider(harness, admin);

    // Book under A (no courier attached yet).
    const book = await harness.app.inject({
      method: "POST",
      url: "/api/merchant-portal/orders",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { customerName: "Test Customer", customerPhone: "+18765550003", addressText: "11 Hope Road, Kingston", items: [{ name: "Widget", quantity: 1 }] },
    });
    const { jobId } = book.json() as { jobId: string };

    // A cannot assign a courier not in its roster (rider never attached to A).
    const noRoster = await harness.app.inject({ method: "POST", url: `/api/merchant-portal/orders/${jobId}/assign`, headers: { authorization: `Bearer ${tokenA}` }, payload: { riderId: rider.id } });
    expect(noRoster.statusCode).toBe(404);

    // B cannot assign a courier to A's order (order not found for B).
    const crossAssign = await harness.app.inject({ method: "POST", url: `/api/merchant-portal/orders/${jobId}/assign`, headers: { authorization: `Bearer ${tokenB}` }, payload: { riderId: rider.id } });
    expect(crossAssign.statusCode).toBe(404);
  });
});

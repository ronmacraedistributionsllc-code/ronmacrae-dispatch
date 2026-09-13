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
});

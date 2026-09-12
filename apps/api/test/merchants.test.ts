/**
 * Merchant CRUD + isolation (Stage 30, spec section 3/58): a merchant
 * belongs to exactly one business; staff never sees another business's
 * merchants; the public resolver only ever exposes the narrow, safe subset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function adminToken(h: TestHarness, businessId?: string) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: businessId ?? h.business.id });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-merchants");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("merchant CRUD and isolation", () => {
  it("creates a merchant with a slugified order link, and rejects a duplicate slug", async () => {
    const auth = await adminToken(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/merchants",
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: "VBR Basics", phone: "+8765551111", notificationEmails: "owner@vbr.example, second@vbr.example" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { merchant: { slug: string; orderUrl: string; notificationEmails: string[] } };
    expect(body.merchant.slug).toBe("vbr-basics");
    expect(body.merchant.orderUrl).toContain("/order/vbr-basics");
    expect(body.merchant.notificationEmails).toEqual(["owner@vbr.example", "second@vbr.example"]);

    const dup = await harness.app.inject({
      method: "POST",
      url: "/api/merchants",
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: "A totally different name", slug: "vbr-basics" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("a dispatcher cannot create a merchant (owner/admin-only), but can list them", async () => {
    const dispatcherUser = await harness.prisma.user.create({ data: { name: "Dee", passwordHash: "unused-in-tests", role: "dispatcher" } });
    const dispatcherTok = await harness.tokenFor({ id: dispatcherUser.id, name: dispatcherUser.name, role: "dispatcher", businessId: harness.business.id });
    const createRes = await harness.app.inject({ method: "POST", url: "/api/merchants", headers: { authorization: `Bearer ${dispatcherTok}` }, payload: { name: "Nope" } });
    expect(createRes.statusCode).toBe(403);
    const listRes = await harness.app.inject({ method: "GET", url: "/api/merchants", headers: { authorization: `Bearer ${dispatcherTok}` } });
    expect(listRes.statusCode).toBe(200);
  });

  it("one business never sees another business's merchants", async () => {
    const otherBusiness = await harness.prisma.business.create({ data: { name: "Other Courier", slug: `other-${uniq()}` } });
    const otherAuth = await adminToken(harness, otherBusiness.id);
    await harness.app.inject({ method: "POST", url: "/api/merchants", headers: { authorization: `Bearer ${otherAuth}` }, payload: { name: "Other's Merchant" } });

    const auth = await adminToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/merchants", headers: { authorization: `Bearer ${auth}` } });
    const body = res.json() as { merchants: { name: string }[] };
    expect(body.merchants.some((m) => m.name === "Other's Merchant")).toBe(false);
  });

  it("the public merchant endpoint exposes only the safe subset, and 404s for an unknown or inactive slug", async () => {
    const auth = await adminToken(harness);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/merchants",
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: "Public Test Store", email: "private@store.example", phone: "+8765559999", notificationEmails: "owner@store.example" },
    });
    const merchant = (created.json() as { merchant: { id: string; slug: string } }).merchant;

    const publicRes = await harness.app.inject({ method: "GET", url: `/api/merchants/public/${merchant.slug}` });
    expect(publicRes.statusCode).toBe(200);
    const publicBody = publicRes.json() as Record<string, unknown>;
    expect(publicBody).not.toHaveProperty("email");
    expect(publicBody).not.toHaveProperty("phone");
    expect(publicBody).not.toHaveProperty("notificationEmails");
    expect((publicBody.merchant as { hasCatalog: boolean }).hasCatalog).toBe(false);

    await harness.app.inject({ method: "PATCH", url: `/api/merchants/${merchant.id}`, headers: { authorization: `Bearer ${auth}` }, payload: { active: false } });
    const disabledRes = await harness.app.inject({ method: "GET", url: `/api/merchants/public/${merchant.slug}` });
    expect(disabledRes.statusCode).toBe(404);

    const unknownRes = await harness.app.inject({ method: "GET", url: "/api/merchants/public/does-not-exist" });
    expect(unknownRes.statusCode).toBe(404);
  });

  it("a product can be created with variants, and the public catalog only lists active ones", async () => {
    const auth = await adminToken(harness);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/merchants",
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: "Catalog Store" },
    });
    const merchant = (created.json() as { merchant: { id: string; slug: string } }).merchant;

    const productRes = await harness.app.inject({
      method: "POST",
      url: `/api/merchants/${merchant.id}/products`,
      headers: { authorization: `Bearer ${auth}` },
      payload: {
        name: "Black Sculpt Set",
        price: 3500,
        variants: [
          { size: "Small", color: "Black" },
          { size: "Medium", color: "Black", priceOverride: 3800 },
        ],
      },
    });
    expect(productRes.statusCode).toBe(200);
    const product = (productRes.json() as { product: { id: string; variants: { price: { amount: number } } []} }).product;
    expect(product.variants).toHaveLength(2);
    // JMD has 0 decimals (no circulating cents) so major === minor here.
    expect(product.variants[1]!.price.amount).toBe(3800); // override wins

    const publicProducts = await harness.app.inject({ method: "GET", url: `/api/merchants/public/${merchant.slug}/products` });
    expect(publicProducts.statusCode).toBe(200);
    expect((publicProducts.json() as { products: unknown[] }).products).toHaveLength(1);

    const hasCatalog = await harness.app.inject({ method: "GET", url: `/api/merchants/public/${merchant.slug}` });
    expect((hasCatalog.json() as { merchant: { hasCatalog: boolean } }).merchant.hasCatalog).toBe(true);
  });
});

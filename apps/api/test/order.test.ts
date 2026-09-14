/**
 * Public multi-item order form (Stage 30, spec section 5/6/13/59):
 * an anonymous customer, no login, can place a multi-item order against a
 * merchant's own link; every price is computed server-side (never trusted
 * from the request); the customer profile is found/created by normalized
 * phone, never duplicated.
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

async function makeMerchant(h: TestHarness, auth: string, overrides: Record<string, unknown> = {}) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/merchants",
    headers: { authorization: `Bearer ${auth}` },
    payload: { name: `VBR Basics ${uniq()}`, notificationEmails: "owner@vbr.example", ...overrides },
  });
  return (res.json() as { merchant: { id: string; name: string; slug: string; businessId: string } }).merchant;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-order");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("public multi-item order — merchant path", () => {
  it("places a real multi-item order: items snapshotted, subtotal computed from them, one customer, one tracking link", async () => {
    const auth = await adminToken(harness);
    const merchant = await makeMerchant(harness, auth);
    const phone = `+18765${uniq().slice(-7)}`;

    const res = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: {
        name: "Jane Brown",
        phone,
        addressText: "3 Constant Spring Road",
        items: [
          { name: "Black Sculpt Set", size: "Small", color: "Black", quantity: 2, unitPrice: 3500 },
          { name: "Basic Tee", size: "Medium", color: "White", quantity: 1, unitPrice: 1200 },
        ],
        paymentMethod: "cod",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      jobId: string;
      jobNumber: string | null;
      merchantName: string | null;
      items: { name: string; quantity: number; lineTotal: { amount: number } }[];
      pricing: { subtotal: { amount: number }; total: { amount: number } };
      tracking: { token: string } | null;
    };
    expect(body.merchantName).toBe(merchant.name);
    expect(body.jobNumber).toMatch(/^RM-\d{6}$/);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]!.lineTotal.amount).toBe(7000); // 2 x 3500
    expect(body.pricing.subtotal.amount).toBe(7000 + 1200);
    expect(body.tracking?.token).toBeTruthy();

    const job = await harness.prisma.job.findUniqueOrThrow({ where: { id: body.jobId }, include: { items: true, customer: true } });
    expect(job.merchantId).toBe(merchant.id);
    expect(job.items).toHaveLength(2);
    expect(job.amountExpected).toBe(body.pricing.total.amount);
    expect(job.customer.phone.startsWith("+")).toBe(true);
  });

  it("never trusts a client-supplied delivery fee — the server always recomputes it", async () => {
    const merchant = await makeMerchant(harness, await adminToken(harness));
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: {
        name: "Fee Test",
        phone: `+18765${uniq().slice(-7)}`,
        addressText: "Somewhere",
        items: [{ name: "Item", quantity: 1, unitPrice: 1000 }],
        // Even if a client tried to smuggle a fee/total through the body,
        // PublicOrderBody has no such field at all — there's no channel for
        // it to travel through. This test's real assertion is structural:
        fee: 1, // ignored — not part of the schema
      } as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pricing: { deliveryFee: unknown; deliveryFeeConfirmed: boolean } };
    // No destination point was given at all, so no zone could be detected —
    // the fee must honestly be unconfirmed, never a client-supplied guess.
    expect(body.pricing.deliveryFeeConfirmed).toBe(false);
    expect(body.pricing.deliveryFee).toBeNull();
  });

  it("resolves a catalog item to its real stored price, ignoring any client-supplied unitPrice for it", async () => {
    const auth = await adminToken(harness);
    const merchant = await makeMerchant(harness, auth);
    const productRes = await harness.app.inject({
      method: "POST",
      url: `/api/merchants/${merchant.id}/products`,
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: "Real Priced Item", price: 5000 },
    });
    const product = (productRes.json() as { product: { id: string } }).product;

    const res = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: {
        name: "Price Spoof Test",
        phone: `+18765${uniq().slice(-7)}`,
        addressText: "Somewhere",
        items: [{ productId: product.id, quantity: 1, unitPrice: 1 }], // attempted spoof
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pricing: { subtotal: { amount: number } } };
    expect(body.pricing.subtotal.amount).toBe(5000); // the real product price, not 1
  });

  it("a product from a different merchant can't be ordered through this merchant's link", async () => {
    const auth = await adminToken(harness);
    const merchantA = await makeMerchant(harness, auth);
    const merchantB = await makeMerchant(harness, auth);
    const productRes = await harness.app.inject({
      method: "POST",
      url: `/api/merchants/${merchantA.id}/products`,
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: "A's Item", price: 1000 },
    });
    const product = (productRes.json() as { product: { id: string } }).product;

    const res = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchantB.slug}`,
      payload: { name: "Cross Merchant Test", phone: `+18765${uniq().slice(-7)}`, addressText: "Somewhere", items: [{ productId: product.id, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("the same normalized phone across two orders reuses one customer profile — never a duplicate", async () => {
    const auth = await adminToken(harness);
    const merchant = await makeMerchant(harness, auth);
    const rawPhone = `876${uniq().slice(-7)}`;

    const first = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: { name: "Repeat Customer", phone: rawPhone, addressText: "First order address", items: [{ name: "Item", quantity: 1, unitPrice: 500 }] },
    });
    expect(first.statusCode).toBe(200);

    const second = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: { name: "Repeat Customer", phone: `+1${rawPhone}`, addressText: "Second order address", items: [{ name: "Item 2", quantity: 1, unitPrice: 700 }] },
    });
    expect(second.statusCode).toBe(200);

    const firstJob = await harness.prisma.job.findUniqueOrThrow({ where: { id: (first.json() as { jobId: string }).jobId } });
    const secondJob = await harness.prisma.job.findUniqueOrThrow({ where: { id: (second.json() as { jobId: string }).jobId } });
    expect(secondJob.customerId).toBe(firstJob.customerId);

    const customers = await harness.prisma.customer.findMany({ where: { businessId: harness.business.id, phone: { contains: rawPhone.slice(-7) } } });
    expect(customers).toHaveLength(1);
  });

  it("rejects an order for an unknown/inactive merchant slug (404, not a fallback to the default store)", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/order/no-such-merchant",
      payload: { name: "Nobody", phone: `+18765${uniq().slice(-7)}`, addressText: "Somewhere", items: [{ name: "Item", quantity: 1, unitPrice: 100 }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("the quote endpoint returns the same pricing shape without creating any order", async () => {
    const merchant = await makeMerchant(harness, await adminToken(harness));
    const before = await harness.prisma.job.count({ where: { merchantId: merchant.id } });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/order/quote",
      payload: { merchantSlug: merchant.slug, items: [{ name: "Item", quantity: 3, unitPrice: 400 }] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { subtotal: { amount: number } }).subtotal.amount).toBe(1200);
    const after = await harness.prisma.job.count({ where: { merchantId: merchant.id } });
    expect(after).toBe(before);
  });
});

describe("inventory availability (spec: 'inventory-availability statuses')", () => {
  async function makeVariantProduct(auth: string, merchantId: string, inventoryQty: number | null) {
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/merchants/${merchantId}/products`,
      headers: { authorization: `Bearer ${auth}` },
      payload: { name: "Tracked Tee", price: 2000, variants: [{ size: "Medium", color: "Black", inventoryQty }] },
    });
    const product = (res.json() as { product: { id: string; variants: { id: string; inventoryQty: number | null }[] } }).product;
    return { product, variant: product.variants[0]! };
  }

  it("a variant with inventoryQty: null (untracked) is orderable in any quantity — the default, unaffected by any of this", async () => {
    const auth = await adminToken(harness);
    const merchant = await makeMerchant(harness, auth);
    const { variant } = await makeVariantProduct(auth, merchant.id, null);
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: { name: "Untracked Buyer", phone: `+18765${uniq().slice(-7)}`, addressText: "Somewhere", items: [{ productVariantId: variant.id, quantity: 50 }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("a variant tracked at 0 stock is refused with a clear, honest error — on both quote and the real order", async () => {
    const auth = await adminToken(harness);
    const merchant = await makeMerchant(harness, auth);
    const { variant } = await makeVariantProduct(auth, merchant.id, 0);

    const quote = await harness.app.inject({
      method: "POST",
      url: "/api/order/quote",
      payload: { merchantSlug: merchant.slug, items: [{ productVariantId: variant.id, quantity: 1 }] },
    });
    expect(quote.statusCode).toBe(409);
    expect((quote.json() as { error: { message: string } }).error.message).toMatch(/out of stock/i);

    const order = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: { name: "Out Of Stock Buyer", phone: `+18765${uniq().slice(-7)}`, addressText: "Somewhere", items: [{ productVariantId: variant.id, quantity: 1 }] },
    });
    expect(order.statusCode).toBe(409);
    // Never a false success — no job was created for the refused order.
    const jobs = await harness.prisma.job.count({ where: { merchantId: merchant.id } });
    expect(jobs).toBe(0);
  });

  it("ordering more than the tracked quantity is refused; ordering exactly the available quantity succeeds", async () => {
    const auth = await adminToken(harness);
    const merchant = await makeMerchant(harness, auth);
    const { variant } = await makeVariantProduct(auth, merchant.id, 3);

    const tooMany = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: { name: "Overbuyer", phone: `+18765${uniq().slice(-7)}`, addressText: "Somewhere", items: [{ productVariantId: variant.id, quantity: 4 }] },
    });
    expect(tooMany.statusCode).toBe(409);
    expect((tooMany.json() as { error: { message: string } }).error.message).toMatch(/only 3 left/i);

    const exact = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: { name: "Exact Buyer", phone: `+18765${uniq().slice(-7)}`, addressText: "Somewhere", items: [{ productVariantId: variant.id, quantity: 3 }] },
    });
    expect(exact.statusCode).toBe(200);
  });

  it("the public catalog already exposes each variant's real inventoryQty, so the ordering UI can show stock before checkout", async () => {
    const auth = await adminToken(harness);
    const merchant = await makeMerchant(harness, auth);
    await makeVariantProduct(auth, merchant.id, 2);

    const res = await harness.app.inject({ method: "GET", url: `/api/merchants/public/${merchant.slug}/products` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { products: { variants: { inventoryQty: number | null }[] }[] };
    expect(body.products[0]!.variants[0]!.inventoryQty).toBe(2);
  });
});

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

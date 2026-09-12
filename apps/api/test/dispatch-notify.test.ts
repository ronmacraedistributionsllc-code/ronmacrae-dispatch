/**
 * Dispatch-side "a new order came in" email (distinct from
 * merchant-notify.ts's merchant email): fires for every order, merchant
 * or not, once the business has `dispatchNotificationEmail` configured.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import type { MemoryEmailProvider } from "@ronmacrae/notifications";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

function emailProvider(): MemoryEmailProvider {
  return harness.ctx.email as MemoryEmailProvider;
}

async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Admin ${uniq()}`, passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin", businessId: h.business.id });
}

// The direct (no-merchant-slug) /api/order path resolves the business by a
// fixed public slug ("ronmacrae" — order.ts's DEFAULT_PUBLIC_BUSINESS_SLUG),
// which the test harness's own auto-created business doesn't have. Ordering
// through a merchant sidesteps that entirely (merchant.businessId is used
// directly) while exercising the exact same dispatch-notify code path.
async function makeMerchant(h: TestHarness, auth: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/api/merchants",
    headers: { authorization: `Bearer ${auth}` },
    payload: { name: `VBR Basics ${uniq()}`, notificationEmails: "owner@vbr.example" },
  });
  return (res.json() as { merchant: { slug: string } }).merchant;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-dispatch-notify");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("dispatch order-alert email", () => {
  it("does nothing when no dispatchNotificationEmail is configured (the default)", async () => {
    const auth = await adminToken(harness);
    const merchant = await makeMerchant(harness, auth);
    const before = emailProvider().sent.length;
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: {
        name: "Jane Brown",
        phone: `+1876555${uniq().slice(-4)}`,
        point: { lat: 18.0, lng: -76.8 },
        addressText: "3 Constant Spring Road, Kingston",
        items: [{ name: "hot dog", quantity: 1, unitPrice: 900 }],
      },
    });
    expect(res.statusCode).toBe(200);
    // exactly one email sent (the merchant's own order-notification email) —
    // no dispatch alert, since none is configured. Both notifications are
    // fire-and-forget (never awaited on the response path), so poll rather
    // than assert immediately.
    await vi.waitFor(() => expect(emailProvider().sent.length).toBe(before + 1));
  });

  it("sends a dispatch alert (separate from the merchant's own email) once configured, and only once", async () => {
    const auth = await adminToken(harness);
    const merchant = await makeMerchant(harness, auth);
    await harness.app.inject({
      method: "PUT",
      url: "/api/settings/business",
      headers: { authorization: `Bearer ${auth}` },
      payload: { businessName: harness.business.name, dispatchNotificationEmail: "dispatch@example.com" },
    });

    const before = emailProvider().sent.length;
    const create = await harness.app.inject({
      method: "POST",
      url: `/api/order/${merchant.slug}`,
      payload: {
        name: "Marcus Green",
        phone: `+1876555${uniq().slice(-4)}`,
        point: { lat: 18.0, lng: -76.8 },
        addressText: "10 Hope Road, Kingston",
        items: [{ name: "burger", quantity: 2, unitPrice: 500 }],
      },
    });
    expect(create.statusCode).toBe(200);
    const { jobId } = create.json() as { jobId: string };
    // the merchant's own email plus the new dispatch alert = 2
    await vi.waitFor(() => expect(emailProvider().sent.length).toBe(before + 2));
    const sent = emailProvider().sent[emailProvider().sent.length - 1]!;
    expect(sent.to).toBe("dispatch@example.com");
    expect(sent.subject).toContain("NEW ORDER");

    await vi.waitFor(async () => {
      const row = await harness.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.dispatchNotifiedAt).not.toBeNull();
    });

    // A manual resend bypasses the guard deliberately; the automatic path
    // (already exercised above) must never double-send on its own.
    const resend = await harness.app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/notify-dispatch`,
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(resend.statusCode).toBe(200);
    expect(emailProvider().sent.length).toBe(before + 3);
  });
});

/**
 * Rider-facing "Contact dispatch" info (Stage 17 / spec 5F). Real Fastify
 * app + real sqlite db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;

async function makeRiderWithJob(h: TestHarness) {
  const rider = await h.prisma.rider.create({ data: { name: "Contact Test Rider", phone: `+1876571${Date.now()}`, active: true, status: "available" } });
  const user = await h.prisma.user.create({ data: { name: rider.name, passwordHash: "unused-in-tests", role: "rider" } });
  const token = await h.tokenFor({ id: user.id, name: user.name, role: "rider", riderId: rider.id });
  const customer = await h.prisma.customer.create({ data: { businessId: h.business.id, name: "Contact Test Customer", phone: `+1876572${Date.now()}` } });
  const job = await h.prisma.job.create({ data: { businessId: h.business.id, customerId: customer.id, riderId: rider.id, status: "assigned" } });
  return { token, jobId: job.id };
}

async function adminToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: "Ada Admin", passwordHash: "unused-in-tests", role: "admin" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "admin" });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-dispatch-contact");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("GET /api/bearer/dispatch-contact", () => {
  it("returns the owner-configured dispatch phone/WhatsApp, never a staff member's own phone", async () => {
    const admin = await adminToken(harness);
    const put = await harness.app.inject({
      method: "PUT",
      url: "/api/settings/business",
      headers: { authorization: `Bearer ${admin}` },
      payload: { businessName: "Test Courier Co", dispatchPhone: "+18765559999", dispatchWhatsApp: "+18765558888" },
    });
    expect(put.statusCode).toBe(200);

    const { token: riderTok, jobId } = await makeRiderWithJob(harness);
    const res = await harness.app.inject({ method: "GET", url: `/api/bearer/dispatch-contact?jobId=${jobId}`, headers: { authorization: `Bearer ${riderTok}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { businessName: string; dispatchPhone: string; dispatchWhatsApp: string };
    expect(body.dispatchPhone).toBe("+18765559999");
    expect(body.dispatchWhatsApp).toBe("+18765558888");
    expect(body.businessName).toBe("Test Courier Co");
    // Only these three fields — nothing else from BusinessSettings (currency,
    // PIN length, etc.) is exposed to the rider via this endpoint.
    expect(Object.keys(body).sort()).toEqual(["businessName", "dispatchPhone", "dispatchWhatsApp"].sort());
  });

  it("is rider-only — staff cannot call the bearer-scoped endpoint", async () => {
    const admin = await adminToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/bearer/dispatch-contact", headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(403);
  });
});

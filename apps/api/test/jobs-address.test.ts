/**
 * Address entry must be exact: what staff typed for the destination/pickup is
 * the authoritative addressText, stored separately from whatever a geocoder
 * matched it to (addressProviderText). This covers the backend half of the
 * "never silently overwrite the typed address" requirement — the frontend half
 * (AddressPicker not overwriting the input on suggestion-pick/pin-drag) is
 * covered by apps/web/src/components/address-picker.test.tsx.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let uniq = 0;

async function writerToken(h: TestHarness) {
  const user = await h.prisma.user.create({
    data: { name: "Dee Dispatcher", passwordHash: "unused-in-tests", role: "dispatcher" },
  });
  return h.tokenFor({ id: user.id, name: user.name, role: "dispatcher" });
}

async function customer(h: TestHarness) {
  uniq += 1;
  return h.prisma.customer.create({ data: { businessId: h.business.id,  name: "Test Customer", phone: `+18765550${String(1000 + uniq)}` } });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-jobs-address");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("POST /api/jobs preserves the exact typed address", () => {
  it("stores a '15-17 ...' style address exactly, plus the provider's differing match, without altering either", async () => {
    const token = await writerToken(harness);
    const c = await customer(harness);
    const typedDestination = "15-17 Half Way Tree Road, Kingston, Jamaica";
    const providerDestination = "15-17 Half Way Tree Rd, Kingston 10, Jamaica"; // provider reformats it slightly
    const typedPickup = "15-17 Half Way Tree Road, Kingston, Jamaica";

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        customerId: c.id,
        addressText: typedDestination,
        addressProviderText: providerDestination,
        point: { lat: 18.0125, lng: -76.7875 },
        pickupAddressText: typedPickup,
        pickupPoint: { lat: 18.0125, lng: -76.7875 },
        itemSummary: "Test parcel",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { job: { addressText: string | null; addressProviderText: string | null; pickupAddressText: string | null } };
    expect(body.job.addressText).toBe(typedDestination);
    expect(body.job.addressProviderText).toBe(providerDestination);
    expect(body.job.pickupAddressText).toBe(typedPickup);
  });

  it("stores an apartment/unit-number address and a landmark-only address exactly, with no provider match found", async () => {
    const token = await writerToken(harness);
    const c = await customer(harness);
    const typedDestination = "Apt 4B, 22 Molynes Road, behind the blue gate";

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        customerId: c.id,
        addressText: typedDestination,
        // provider genuinely couldn't find/confirm this one — omitted entirely
        point: { lat: 18.03, lng: -76.79 },
        landmark: "Behind the blue gate, ask for Miss Pat",
        pickupAddressText: "15-17 Half Way Tree Road, Kingston, Jamaica",
        pickupPoint: { lat: 18.0125, lng: -76.7875 },
        itemSummary: "Test parcel",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      job: { addressText: string | null; addressProviderText: string | null; landmark: string | null };
    };
    expect(body.job.addressText).toBe(typedDestination);
    expect(body.job.addressProviderText).toBeNull(); // no provider match — not fabricated, never coerced to the typed text
    expect(body.job.landmark).toBe("Behind the blue gate, ask for Miss Pat");
  });

  it("a PATCH updating only the point never touches the previously-typed addressText", async () => {
    const token = await writerToken(harness);
    const c = await customer(harness);
    const typedDestination = "17 Grants Pen Road";

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        customerId: c.id,
        addressText: typedDestination,
        point: { lat: 18.02, lng: -76.8 },
        pickupAddressText: "15-17 Half Way Tree Road, Kingston, Jamaica",
        pickupPoint: { lat: 18.0125, lng: -76.7875 },
        itemSummary: "Test parcel",
      },
    });
    const jobId = (created.json() as { job: { id: string } }).job.id;

    // simulate dragging the pin: only the point (and the informational provider
    // label from reverse-geocoding) changes — addressText is not part of this PATCH
    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { point: { lat: 18.021, lng: -76.801 }, addressProviderText: "Some Other Street Entirely" },
    });

    expect(patched.statusCode).toBe(200);
    const body = patched.json() as { job: { addressText: string | null; point: { lat: number; lng: number } | null } };
    expect(body.job.addressText).toBe(typedDestination);
    expect(body.job.point).toEqual({ lat: 18.021, lng: -76.801 });
  });
});

/**
 * Courier search on GET /api/riders?q= — matches name or phone, case
 * insensitively, and never reaches into another business's couriers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let auth: { authorization: string };
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function member(businessId: string, name: string, phone: string) {
  const rider = await harness.prisma.rider.create({ data: { name, phone, active: true, status: "available" } });
  // The harness enrols every new courier in its default business; keep only the membership we ask for.
  await harness.prisma.riderMembership.deleteMany({ where: { riderId: rider.id } });
  await harness.prisma.riderMembership.create({ data: { riderId: rider.id, businessId, status: "active", approvedAt: new Date() } });
  return rider;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-riders-search");
  const user = await harness.prisma.user.create({ data: { name: `Dispatcher ${uniq()}`, passwordHash: "unused-in-tests", role: "dispatcher" } });
  auth = { authorization: `Bearer ${await harness.tokenFor({ id: user.id, name: user.name, role: "dispatcher", businessId: harness.business.id })}` };
});

afterAll(async () => {
  await harness.cleanup();
});

async function search(q?: string): Promise<{ name: string; phone: string }[]> {
  const res = await harness.app.inject({ method: "GET", url: `/api/riders${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`, headers: auth });
  expect(res.statusCode).toBe(200);
  return (res.json() as { riders: { name: string; phone: string }[] }).riders;
}

describe("GET /api/riders?q=", () => {
  it("matches name (any case) and phone (ignoring spaces), and returns everyone with no query", async () => {
    await member(harness.business.id, "Zephyrine Quill", "+18765561001");
    await member(harness.business.id, "Orlando Vane", "+18765561002");

    expect((await search("zEpHyR")).map((r) => r.name)).toEqual(["Zephyrine Quill"]);
    expect((await search("876 556 1002")).map((r) => r.name)).toEqual(["Orlando Vane"]);
    expect((await search("nobody-by-this-name")).length).toBe(0);
    const all = (await search()).map((r) => r.name);
    expect(all).toEqual(expect.arrayContaining(["Zephyrine Quill", "Orlando Vane"]));
    expect((await search("   ")).length).toBe(all.length); // blank is the same as no search
  });

  it("never returns another business's couriers, even for an exact name match", async () => {
    const other = await harness.prisma.business.create({ data: { name: `Other Co ${uniq()}`, slug: `other-${uniq()}` } });
    await member(other.id, "Cross Tenant Courier", "+18765561003");
    expect(await search("Cross Tenant")).toEqual([]);
    expect(await search("5561003")).toEqual([]);
  });

  it("treats the query as plain text, not a pattern", async () => {
    expect(await search("%")).toEqual([]);
    expect(await search("' OR 1=1 --")).toEqual([]);
  });
});

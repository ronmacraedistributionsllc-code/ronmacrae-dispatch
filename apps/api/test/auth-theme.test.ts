/**
 * Stage E (spec: theme switcher, "persist per user"). Real Fastify app +
 * real sqlite db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function staffToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: `Theme Test ${uniq()}`, passwordHash: "unused-in-tests", role: "dispatcher" } });
  return { userId: user.id, token: await h.tokenFor({ id: user.id, name: user.name, role: "dispatcher", businessId: h.business.id }) };
}

beforeAll(async () => {
  harness = await buildTestHarness("test-auth-theme");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("PUT /api/auth/theme", () => {
  it("saves the caller's own theme choice, surfaced back on /api/auth/me", async () => {
    const { userId, token } = await staffToken(harness);
    const before = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect((before.json() as { user: { theme: string | null } }).user.theme).toBeNull();

    const put = await harness.app.inject({ method: "PUT", url: "/api/auth/theme", headers: { authorization: `Bearer ${token}` }, payload: { theme: "ronmacrae-blue" } });
    expect(put.statusCode).toBe(200);
    const row = await harness.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.theme).toBe("ronmacrae-blue");

    const after = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect((after.json() as { user: { theme: string | null } }).user.theme).toBe("ronmacrae-blue");
  });

  it("clearing back to null (the default) works, and requires authentication", async () => {
    const { userId, token } = await staffToken(harness);
    await harness.app.inject({ method: "PUT", url: "/api/auth/theme", headers: { authorization: `Bearer ${token}` }, payload: { theme: "night-courier" } });
    const clear = await harness.app.inject({ method: "PUT", url: "/api/auth/theme", headers: { authorization: `Bearer ${token}` }, payload: { theme: null } });
    expect(clear.statusCode).toBe(200);
    expect((await harness.prisma.user.findUniqueOrThrow({ where: { id: userId } })).theme).toBeNull();

    const noAuth = await harness.app.inject({ method: "PUT", url: "/api/auth/theme", payload: { theme: "jamaica" } });
    expect(noAuth.statusCode).toBe(401);
  });

  it("never affects another user's saved theme", async () => {
    const a = await staffToken(harness);
    const b = await staffToken(harness);
    await harness.app.inject({ method: "PUT", url: "/api/auth/theme", headers: { authorization: `Bearer ${a.token}` }, payload: { theme: "midnight-gold" } });
    const bRow = await harness.prisma.user.findUniqueOrThrow({ where: { id: b.userId } });
    expect(bRow.theme).toBeNull();
  });
});

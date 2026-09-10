/**
 * Integration tests for the opt-in Web Push subscription routes. Same real
 * app + real sqlite db harness as offers.test.ts.
 *
 * What this does NOT cover: actually delivering a push message to a browser.
 * PushService.sendToUser/sendToRider call the real `web-push` library against
 * whatever `endpoint` URL a subscription row holds — a genuine end-to-end proof
 * needs a real browser's Push API (or a mocked push service), which is out of
 * scope for an automated integration test here. What's covered is the part that
 * is deterministically testable: the HTTP surface (auth, validation, and —
 * importantly — that unsubscribe is scoped to the caller's own subscription and
 * can't remove another user's).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function userToken(h: TestHarness) {
  const user = await h.prisma.user.create({ data: { name: "Push Test User", passwordHash: "unused-in-tests", role: "dispatcher" } });
  return h.tokenFor({ id: user.id, name: user.name, role: "dispatcher" });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-push");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("GET /api/push/public-key", () => {
  it("requires authentication", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/push/public-key" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the configured VAPID public key for an authenticated user", async () => {
    const token = await userToken(harness);
    const res = await harness.app.inject({ method: "GET", url: "/api/push/public-key", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { publicKey: string };
    expect(body.publicKey).toBe(harness.ctx.config.VAPID_PUBLIC_KEY);
    expect(body.publicKey.length).toBeGreaterThan(0);
  });
});

describe("POST /api/push/subscribe", () => {
  it("requires authentication", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: { endpoint: "https://push.example.com/x", keys: { p256dh: "a", auth: "b" } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed subscription body", async () => {
    const token = await userToken(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      headers: { authorization: `Bearer ${token}` },
      payload: { endpoint: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("stores a subscription for the authenticated user, and re-subscribing the same endpoint upserts rather than erroring", async () => {
    const user = await harness.prisma.user.create({ data: { name: "Sub Test User", passwordHash: "unused-in-tests", role: "rider" } });
    const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider" });
    const endpoint = `https://push.example.com/${uniq()}`;

    const first = await harness.app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      headers: { authorization: `Bearer ${token}` },
      payload: { endpoint, keys: { p256dh: "p256dh-1", auth: "auth-1" } },
    });
    expect(first.statusCode).toBe(200);

    const row = await harness.prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint } });
    expect(row.userId).toBe(user.id);
    expect(row.p256dh).toBe("p256dh-1");

    // re-subscribe (e.g. key rotation) — same endpoint, new keys: upsert, not a duplicate row
    const second = await harness.app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      headers: { authorization: `Bearer ${token}` },
      payload: { endpoint, keys: { p256dh: "p256dh-2", auth: "auth-2" } },
    });
    expect(second.statusCode).toBe(200);
    const rows = await harness.prisma.pushSubscription.findMany({ where: { endpoint } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe("p256dh-2");
  });
});

describe("POST /api/push/unsubscribe", () => {
  it("requires authentication", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/api/push/unsubscribe", payload: { endpoint: "https://push.example.com/x" } });
    expect(res.statusCode).toBe(401);
  });

  it("removes the caller's own subscription", async () => {
    const user = await harness.prisma.user.create({ data: { name: "Owner", passwordHash: "unused-in-tests", role: "rider" } });
    const token = await harness.tokenFor({ id: user.id, name: user.name, role: "rider" });
    const endpoint = `https://push.example.com/${uniq()}`;
    await harness.prisma.pushSubscription.create({ data: { userId: user.id, endpoint, p256dh: "p", auth: "a" } });

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/push/unsubscribe",
      headers: { authorization: `Bearer ${token}` },
      payload: { endpoint },
    });
    expect(res.statusCode).toBe(200);
    const row = await harness.prisma.pushSubscription.findUnique({ where: { endpoint } });
    expect(row).toBeNull();
  });

  it("cannot remove another user's subscription (scoped by userId, not just endpoint)", async () => {
    const owner = await harness.prisma.user.create({ data: { name: "Owner2", passwordHash: "unused-in-tests", role: "rider" } });
    const attacker = await harness.prisma.user.create({ data: { name: "Attacker", passwordHash: "unused-in-tests", role: "rider" } });
    const attackerToken = await harness.tokenFor({ id: attacker.id, name: attacker.name, role: "rider" });
    const endpoint = `https://push.example.com/${uniq()}`;
    await harness.prisma.pushSubscription.create({ data: { userId: owner.id, endpoint, p256dh: "p", auth: "a" } });

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/push/unsubscribe",
      headers: { authorization: `Bearer ${attackerToken}` },
      payload: { endpoint },
    });
    // The route itself doesn't leak whether the endpoint exists (always 200) —
    // what matters is the row survives untouched.
    expect(res.statusCode).toBe(200);
    const row = await harness.prisma.pushSubscription.findUnique({ where: { endpoint } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(owner.id);
  });
});

/**
 * Native push (FCM) for the Android shell: token register/unregister routes,
 * logout cleanup, health reporting, and the Web Push de-dupe fan-out.
 *
 * The FCM HTTP layer itself is never hit for real here: service-level tests
 * inject a fake `NativePushSender` into the harness's PushService, and one
 * small `FcmSender` block below tests the real JWT + HTTP shape against a
 * stubbed fetch (with a throwaway RSA key generated in-memory — no
 * credentials anywhere).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { FcmSender, type FcmMessage, type NativeSendResult } from "../src/modules/push.js";

vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn(() => Promise.resolve()) },
}));

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;

async function makeUser(role: "rider" | "dispatcher" = "rider") {
  const user = await harness.prisma.user.create({ data: { name: `Native Push ${uniq()}`, passwordHash: "unused", role } });
  const token = await harness.tokenFor({ id: user.id, name: user.name, role });
  return { user, auth: { authorization: `Bearer ${token}` } };
}

/** Controllable fake FCM: per-test result + a record of every message. */
function fakeSender(result: NativeSendResult = "sent") {
  const calls: { token: string; message: FcmMessage }[] = [];
  return {
    calls,
    sender: {
      sendToToken: async (token: string, message: FcmMessage): Promise<NativeSendResult> => {
        calls.push({ token, message });
        return result;
      },
    },
  };
}

beforeAll(async () => {
  harness = await buildTestHarness("test-push-native");
  harness.ctx.push.__setNativeSenderForTests(fakeSender("sent").sender);
});

afterAll(async () => {
  await harness.cleanup();
});

describe("POST /api/push/native/register", () => {
  it("requires authentication", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/push/native/register",
      payload: { token: "fcm-token-0000000000", platform: "android" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("validates the body", async () => {
    const { auth } = await makeUser();
    for (const payload of [
      { token: "short", platform: "android" },
      { token: "fcm-token-0000000000", platform: "ios" },
      { platform: "android" },
    ]) {
      const res = await harness.app.inject({ method: "POST", url: "/api/push/native/register", headers: auth, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("stores the token on the caller's account, and re-registering moves it", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const token = `fcm-token-${uniq()}-0000000000`;
    const first = await harness.app.inject({ method: "POST", url: "/api/push/native/register", headers: a.auth, payload: { token, platform: "android", appVersion: "3" } });
    expect(first.statusCode).toBe(200);
    expect(await harness.prisma.devicePushToken.findUnique({ where: { token } })).toMatchObject({ userId: a.user.id, platform: "android", appVersion: "3" });

    const second = await harness.app.inject({ method: "POST", url: "/api/push/native/register", headers: b.auth, payload: { token, platform: "android" } });
    expect(second.statusCode).toBe(200);
    expect(await harness.prisma.devicePushToken.findUnique({ where: { token } })).toMatchObject({ userId: b.user.id });
    expect(await harness.prisma.devicePushToken.count({ where: { token } })).toBe(1);
  });
});

describe("POST /api/push/native/unregister", () => {
  it("requires authentication", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/api/push/native/unregister", payload: { token: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("removes only the caller's own token", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const tokenB = `fcm-token-b-${uniq()}-0000000000`;
    await harness.app.inject({ method: "POST", url: "/api/push/native/register", headers: b.auth, payload: { token: tokenB, platform: "android" } });

    const res = await harness.app.inject({ method: "POST", url: "/api/push/native/unregister", headers: a.auth, payload: { token: tokenB } });
    expect(res.statusCode).toBe(200);
    // A's request names B's token but is scoped to A's own userId — B keeps it.
    expect(await harness.prisma.devicePushToken.findUnique({ where: { token: tokenB } })).not.toBeNull();

    const own = await harness.app.inject({ method: "POST", url: "/api/push/native/unregister", headers: b.auth, payload: { token: tokenB } });
    expect(own.statusCode).toBe(200);
    expect(await harness.prisma.devicePushToken.findUnique({ where: { token: tokenB } })).toBeNull();
  });
});

describe("logout + health", () => {
  it("logout removes every native token the account had, on every device", async () => {
    const me = await makeUser();
    const other = await makeUser();
    for (const device of ["phone", "tablet"]) {
      await harness.prisma.devicePushToken.create({ data: { userId: me.user.id, token: `fcm-${device}-${uniq()}-0000000000`, platform: "android" } });
    }
    await harness.prisma.devicePushToken.create({ data: { userId: other.user.id, token: `fcm-other-${uniq()}-0000000000`, platform: "android" } });

    const res = await harness.app.inject({ method: "POST", url: "/api/auth/logout", headers: me.auth });
    expect(res.statusCode).toBe(200);
    expect(await harness.prisma.devicePushToken.count({ where: { userId: me.user.id } })).toBe(0);
    expect(await harness.prisma.devicePushToken.count({ where: { userId: other.user.id } })).toBe(1);
  });

  it("health reports native push state", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    // The harness injects a fake sender, so the test app reports enabled;
    // production without FCM_* env vars reports "disabled" (same code path).
    expect(res.json()).toMatchObject({ nativePush: "enabled" });
    harness.ctx.push.__setNativeSenderForTests(null);
    const off = await harness.app.inject({ method: "GET", url: "/api/health" });
    expect(off.json()).toMatchObject({ nativePush: "disabled" });
    harness.ctx.push.__setNativeSenderForTests(fakeSender("sent").sender);
  });
});

describe("fan-out + Web Push de-dupe", () => {
  it("a recently-seen native token that sends OK suppresses the Web Push duplicate", async () => {
    const { user } = await makeUser();
    const fake = fakeSender("sent");
    harness.ctx.push.__setNativeSenderForTests(fake.sender);
    await harness.prisma.devicePushToken.create({ data: { userId: user.id, token: `fcm-dedupe-${uniq()}-0000000000`, platform: "android" } });
    await harness.prisma.pushSubscription.create({ data: { userId: user.id, endpoint: `https://push.example.com/${uniq()}`, p256dh: "k", auth: "a" } });

    await harness.ctx.push.sendToUser(user.id, { title: "New delivery offer", body: "b", tag: "offer-1", url: "/" }, { kind: "offer" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      message: { title: "New delivery offer", kind: "offer", channelId: "job_offers", tag: "offer-1", url: "/" },
    });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("falls back to Web Push when no native send succeeds", async () => {
    const { user } = await makeUser();
    harness.ctx.push.__setNativeSenderForTests(fakeSender("failed").sender);
    await harness.prisma.devicePushToken.create({ data: { userId: user.id, token: `fcm-fallback-${uniq()}-0000000000`, platform: "android" } });
    await harness.prisma.pushSubscription.create({ data: { userId: user.id, endpoint: `https://push.example.com/${uniq()}`, p256dh: "k", auth: "a" } });

    vi.clearAllMocks();
    await harness.ctx.push.sendToUser(user.id, { title: "t", body: "b" }, { kind: "message" });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("stale tokens (>30 days) never suppress Web Push but are refreshed on success", async () => {
    const { user } = await makeUser();
    const fake = fakeSender("sent");
    harness.ctx.push.__setNativeSenderForTests(fake.sender);
    const stale = await harness.prisma.devicePushToken.create({ data: { userId: user.id, token: `fcm-stale-${uniq()}-0000000000`, platform: "android" } });
    await harness.prisma.devicePushToken.update({ where: { id: stale.id }, data: { lastSeenAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) } });
    await harness.prisma.pushSubscription.create({ data: { userId: user.id, endpoint: `https://push.example.com/${uniq()}`, p256dh: "k", auth: "a" } });

    vi.clearAllMocks();
    await harness.ctx.push.sendToUser(user.id, { title: "t" });
    expect(fake.calls).toHaveLength(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    const refreshed = await harness.prisma.devicePushToken.findUnique({ where: { id: stale.id } });
    expect(refreshed!.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("dead tokens are pruned like dead Web Push subscriptions", async () => {
    const { user } = await makeUser();
    harness.ctx.push.__setNativeSenderForTests(fakeSender("dead").sender);
    const row = await harness.prisma.devicePushToken.create({ data: { userId: user.id, token: `fcm-dead-${uniq()}-0000000000`, platform: "android" } });
    await harness.ctx.push.sendToUser(user.id, { title: "t" });
    expect(await harness.prisma.devicePushToken.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it("disabled mode is a no-op that still sends Web Push", async () => {
    const { user } = await makeUser();
    harness.ctx.push.__setNativeSenderForTests(null);
    await harness.prisma.devicePushToken.create({ data: { userId: user.id, token: `fcm-off-${uniq()}-0000000000`, platform: "android" } });
    await harness.prisma.pushSubscription.create({ data: { userId: user.id, endpoint: `https://push.example.com/${uniq()}`, p256dh: "k", auth: "a" } });
    vi.clearAllMocks();
    await expect(harness.ctx.push.sendToUser(user.id, { title: "t" })).resolves.toBeUndefined();
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    harness.ctx.push.__setNativeSenderForTests(fakeSender("sent").sender);
  });
});

describe("FcmSender HTTP shape (stubbed fetch, throwaway key)", () => {
  const saPath = join(tmpdir(), `ronmacrae-fcm-test-${process.pid}.json`);
  const projectId = "demo-project";

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    writeFileSync(saPath, JSON.stringify({ client_email: "fcm@demo-project.iam.gserviceaccount.com", private_key: pem, token_uri: "https://oauth2.googleapis.com/token" }));
  });

  afterAll(() => {
    rmSync(saPath, { force: true });
  });

  function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    return vi.fn(async (url: unknown, init: unknown) => handler(url as string, init as RequestInit));
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("mints an OAuth token once, then sends HIGH-priority messages to the job_offers channel", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = stubFetch((url, init) => {
      seen.push({ url, init });
      if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "ya29.test", expires_in: 3600 });
      return json({ name: "projects/demo-project/messages/1" });
    });
    const sender = new FcmSender(projectId, saPath, harness.ctx.log, fetchFn as unknown as typeof fetch);
    const msg: FcmMessage = { title: "New delivery offer", body: "A → B", tag: "offer-9", url: "/", kind: "offer", channelId: "job_offers" };
    expect(await sender.sendToToken("device-token-1", msg)).toBe("sent");
    expect(await sender.sendToToken("device-token-2", msg)).toBe("sent");

    const tokenCalls = seen.filter((s) => s.url.includes("oauth2"));
    expect(tokenCalls).toHaveLength(1);
    // The assertion is a real RS256 JWT (header.payload.signature).
    const assertion = new URLSearchParams(tokenCalls[0]!.init.body as string).get("assertion") ?? "";
    expect(assertion.split(".")).toHaveLength(3);

    const sends = seen.filter((s) => s.url.includes("messages:send"));
    expect(sends).toHaveLength(2);
    expect(sends[0]!.url).toBe(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`);
    expect(sends[0]!.init.headers).toMatchObject({ Authorization: "Bearer ya29.test" });
    expect(JSON.parse(sends[0]!.init.body as string)).toEqual({
      message: {
        token: "device-token-1",
        notification: { title: "New delivery offer", body: "A → B" },
        data: { kind: "offer", url: "/", tag: "offer-9" },
        android: { priority: "HIGH", collapse_key: "offer-9", notification: { channel_id: "job_offers", tag: "offer-9" } },
      },
    });
  });

  it("maps gone tokens to dead, rejections and network errors to failed", async () => {
    const mk = (handler: (url: string) => Response | Promise<Response>) =>
      new FcmSender(projectId, saPath, harness.ctx.log, stubFetch((url, init) => (url === "https://oauth2.googleapis.com/token" ? json({ access_token: "t", expires_in: 3600 }) : handler(url))) as unknown as typeof fetch);
    const msg: FcmMessage = { title: "t", body: "b", kind: "message", channelId: "messages" };
    expect(await mk(() => json({ error: { status: "NOT_FOUND" } }, 404)).sendToToken("gone", msg)).toBe("dead");
    expect(await mk(() => json({ error: { status: "INVALID_ARGUMENT" } }, 400)).sendToToken("bad", msg)).toBe("dead");
    expect(await mk(() => json({ error: { status: "UNAVAILABLE" } }, 503)).sendToToken("x", msg)).toBe("failed");
    expect(
      await mk(() => {
        throw new Error("down");
      }).sendToToken("x", msg),
    ).toBe("failed");
  });
});

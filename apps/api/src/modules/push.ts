import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import webpush from "web-push";
import type { AppCtx } from "../ctx.js";
import type { PrismaClient } from "../prisma.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../lib/log.js";

const SubscriptionBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
const UnsubscribeBody = z.object({ endpoint: z.string().url() });

const NativeRegisterBody = z.object({
  token: z.string().min(10).max(500),
  platform: z.enum(["android"]),
  appVersion: z.string().max(50).optional(),
});
const NativeUnregisterBody = z.object({ token: z.string().min(1).max(500) });

/** What kind of event a push carries — selects the Android channel (Phase 4). */
export type NativePushKind = "offer" | "assignment" | "message" | "order";

export interface FcmMessage {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  kind: NativePushKind;
  channelId: string;
}

export type NativeSendResult = "sent" | "dead" | "failed";

export interface NativePushSender {
  sendToToken(token: string, message: FcmMessage): Promise<NativeSendResult>;
}

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

const FCM_TOKEN_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_FETCH_TIMEOUT_MS = 10_000;

/**
 * Minimal FCM HTTP v1 sender (no firebase-admin dependency): mints its own
 * OAuth2 access token from the service-account JSON (RS256 JWT) and POSTs
 * one message per device token. Reads the key file lazily and caches the
 * access token until shortly before expiry. Never throws — every failure
 * path returns "failed" (or "dead" for tokens FCM says are gone).
 */
export class FcmSender implements NativePushSender {
  private account: ServiceAccountJson | null | undefined;
  private cachedAccess: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly projectId: string,
    private readonly serviceAccountPath: string,
    private readonly log: Logger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private loadAccount(): ServiceAccountJson | null {
    if (this.account === undefined) {
      try {
        this.account = JSON.parse(readFileSync(this.serviceAccountPath, "utf8")) as ServiceAccountJson;
      } catch (err) {
        // Path only, never contents — the key file is a real credential.
        this.log.error({ err: String(err), path: this.serviceAccountPath }, "FCM service account unreadable; native push disabled");
        this.account = null;
      }
      if (this.account && (!this.account.client_email || !this.account.private_key)) {
        this.log.error({ path: this.serviceAccountPath }, "FCM service account is missing client_email/private_key; native push disabled");
        this.account = null;
      }
    }
    return this.account ?? null;
  }

  private async accessToken(): Promise<string | null> {
    if (this.cachedAccess && Date.now() < this.cachedAccess.expiresAt) return this.cachedAccess.value;
    const sa = this.loadAccount();
    if (!sa?.client_email || !sa?.private_key) return null;
    const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
      JSON.stringify({ iss: sa.client_email, scope: FCM_TOKEN_SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }),
    )}`;
    let assertion: string;
    try {
      assertion = `${signingInput}.${createSign("RSA-SHA256").update(signingInput).sign(sa.private_key, "base64url") as string}`;
    } catch (err) {
      this.log.error({ err: String(err) }, "FCM assertion signing failed");
      return null;
    }
    let res: Response;
    try {
      res = await this.fetchFn(tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        signal: AbortSignal.timeout(FCM_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, "FCM token request failed");
      return null;
    }
    if (!res.ok) {
      this.log.warn({ status: res.status }, "FCM token request rejected");
      return null;
    }
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!body?.access_token) return null;
    this.cachedAccess = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - 60_000 };
    return body.access_token;
  }

  async sendToToken(token: string, message: FcmMessage): Promise<NativeSendResult> {
    const access = await this.accessToken();
    if (!access) return "failed";
    const data: Record<string, string> = { kind: message.kind };
    if (message.url) data.url = message.url;
    if (message.tag) data.tag = message.tag;
    let res: Response | null;
    try {
      res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data,
            android: {
              priority: "HIGH",
              ...(message.tag ? { collapse_key: message.tag } : {}),
              notification: { channel_id: message.channelId, ...(message.tag ? { tag: message.tag } : {}) },
            },
          },
        }),
        signal: AbortSignal.timeout(FCM_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, "FCM send failed");
      return "failed";
    }
    if (!res) return "failed";
    if (res.ok) return "sent";
    // Dead-token hygiene (mirrors the 404/410 pruning for Web Push):
    // FCM v1 reports a gone token as 404/NOT_FOUND (UNREGISTERED) and a
    // malformed one as INVALID_ARGUMENT.
    let status: string | undefined;
    try {
      status = ((await res.json()) as { error?: { status?: string } } | null)?.error?.status;
    } catch {
      status = undefined;
    }
    if (res.status === 404 || status === "NOT_FOUND" || status === "INVALID_ARGUMENT") return "dead";
    this.log.warn({ status: res.status, fcmStatus: status }, "FCM send rejected");
    return "failed";
  }
}

/**
 * Opt-in Web Push (VAPID) + native push (FCM) fan-out. A user's subscriptions
 * live in `PushSubscription` (one row per browser/device, keyed by the push
 * service's unique `endpoint`); native device tokens live in
 * `DevicePushToken` (one row per shell install, keyed by FCM `token`).
 * Sending is always best-effort: a failed push must never break the caller
 * (mirrors AuditService.record's must-never-break-the-primary-operation rule).
 */
export class PushService {
  private configured = false;
  private cachedNative: NativePushSender | null | undefined;
  private disabledLogged = false;
  private testSender: NativePushSender | null | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
    private readonly log: Logger,
    nativeSender?: NativePushSender | null,
  ) {
    if (nativeSender !== undefined) this.testSender = nativeSender;
  }

  /** Test hook: force the native sender (or force disabled with null). */
  __setNativeSenderForTests(sender: NativePushSender | null): void {
    this.testSender = sender;
    this.cachedNative = undefined;
  }

  private ensureConfigured(): void {
    if (this.configured) return;
    webpush.setVapidDetails(this.config.VAPID_SUBJECT, this.config.VAPID_PUBLIC_KEY, this.config.VAPID_PRIVATE_KEY);
    this.configured = true;
  }

  /** Null when native push is disabled (unset config) — never throws. */
  private nativeSender(): NativePushSender | null {
    if (this.testSender !== undefined) return this.testSender;
    if (this.cachedNative !== undefined) return this.cachedNative;
    const { FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_PATH } = this.config;
    if (!FCM_PROJECT_ID || !FCM_SERVICE_ACCOUNT_PATH) {
      if (!this.disabledLogged) {
        this.disabledLogged = true;
        this.log.info("native push disabled (FCM_PROJECT_ID/FCM_SERVICE_ACCOUNT_PATH unset)");
      }
      this.cachedNative = null;
      return null;
    }
    this.cachedNative = new FcmSender(FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_PATH, this.log);
    return this.cachedNative;
  }

  /** For /api/health: "enabled" only when a sender can actually be built. */
  nativePushStatus(): "enabled" | "disabled" {
    return this.nativeSender() ? "enabled" : "disabled";
  }

  async subscribe(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      // a re-subscribe (e.g. key rotation) can move an endpoint to a new user's browser profile
      update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
  }

  /** Only removes the caller's own subscription — scoped by userId, not just endpoint. */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  /** Register (or move) one shell's FCM token onto the caller's account. */
  async registerNativeToken(userId: string, input: { token: string; platform: string; appVersion?: string }): Promise<void> {
    await this.prisma.devicePushToken.upsert({
      where: { token: input.token },
      create: { userId, token: input.token, platform: input.platform, appVersion: input.appVersion, lastSeenAt: new Date() },
      // re-registering (e.g. reinstall, account switch) moves the token
      update: { userId, platform: input.platform, appVersion: input.appVersion, lastSeenAt: new Date() },
    });
  }

  /** Only removes the caller's own token — scoped by userId, not just token. */
  async unregisterNativeToken(userId: string, token: string): Promise<void> {
    await this.prisma.devicePushToken.deleteMany({ where: { userId, token } });
  }

  /** Logout guarantee: no device keeps receiving this account's alerts. */
  async removeAllNativeTokens(userId: string): Promise<void> {
    await this.prisma.devicePushToken.deleteMany({ where: { userId } });
  }

  /** Push a small JSON payload to every device a user has opted in on. Best-effort. */
  async sendToUser(userId: string, payload: Record<string, unknown>, opts: { kind?: NativePushKind } = {}): Promise<void> {
    const title = typeof payload.title === "string" ? payload.title : "Ronmacrae Dispatch";
    const body = typeof payload.body === "string" ? payload.body : "";
    const tag = typeof payload.tag === "string" ? payload.tag : undefined;
    const url = typeof payload.url === "string" ? payload.url : "/";
    const kind = opts.kind ?? "message";
    const channelId = kind === "offer" || kind === "assignment" ? "job_offers" : "messages";

    // Native fan-out first. Stale tokens (>30 days unseen) are still tried
    // (refreshes lastSeenAt on success, prunes dead ones) but never suppress
    // the Web Push below — only a token seen recently that we JUST reached
    // suppresses the duplicate.
    let nativeReached = false;
    let hasRecentToken = false;
    const sender = this.nativeSender();
    if (sender) {
      const tokens = await this.prisma.devicePushToken.findMany({ where: { userId } });
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      for (const t of tokens) {
        if (t.lastSeenAt.getTime() >= cutoff) hasRecentToken = true;
        let result: NativeSendResult;
        try {
          result = await sender.sendToToken(t.token, { title, body, tag, url, kind, channelId });
        } catch (err) {
          this.log.warn({ err: String(err), userId }, "native push send failed");
          result = "failed";
        }
        if (result === "sent") {
          nativeReached = true;
          await this.prisma.devicePushToken.updateMany({ where: { id: t.id }, data: { lastSeenAt: new Date() } });
        } else if (result === "dead") {
          // token is gone (uninstall) — standard push hygiene: drop it
          await this.prisma.devicePushToken.deleteMany({ where: { id: t.id } });
        }
      }
    }
    // De-dupe rule: reached natively right now => skip Web Push for this
    // send. Trade-off (see checkpoint): if FCM is down such that NO native
    // send succeeds, Web Push still goes out as the fallback.
    if (hasRecentToken && nativeReached) return;
    await this.sendWebPush(userId, payload);
  }

  private async sendWebPush(userId: string, payload: Record<string, unknown>): Promise<void> {
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (subs.length === 0) return;
    this.ensureConfigured();
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            // subscription is gone (uninstalled / expired) - standard push hygiene: drop it
            await this.prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
          } else {
            this.log.warn({ err: String(err), userId, statusCode }, "push send failed");
          }
        }
      }),
    );
  }

  /** Convenience: push to a rider's linked user account, if any. */
  async sendToRider(riderId: string, payload: Record<string, unknown>, opts: { kind?: NativePushKind } = {}): Promise<void> {
    const rider = await this.prisma.rider.findUnique({ where: { id: riderId }, select: { userId: true } });
    if (rider?.userId) await this.sendToUser(rider.userId, payload, opts);
  }

  /** Push every admin/dispatcher at one business who's opted in — the
   *  staff-side equivalent of sendToRider, for events dispatch needs to
   *  know about even with the app closed/backgrounded (spec: "when an
   *  order comes in the dispatch courier get a notification of a new
   *  order the same" as an offer already pushes a courier). Scoped to
   *  admin/dispatcher only — accountant/viewer don't act on new orders,
   *  same role set offers.ts's own writer guard uses. `excludeUserId`
   *  skips whoever just performed the action themselves (a dispatcher who
   *  just typed in a booking doesn't need to be told about it). */
  async sendToBusinessStaff(
    businessId: string,
    payload: Record<string, unknown>,
    excludeUserId?: string,
    opts: { kind?: NativePushKind } = {},
  ): Promise<void> {
    const memberships = await this.prisma.staffMembership.findMany({
      where: { businessId, active: true, role: { in: ["admin", "dispatcher"] }, ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) },
      select: { userId: true },
    });
    await Promise.all(memberships.map((m) => this.sendToUser(m.userId, payload, opts)));
  }
}

export async function pushRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/push/public-key", { preHandler: ctx.requireAuth }, async () => ({ publicKey: ctx.config.VAPID_PUBLIC_KEY }));

  app.post("/api/push/subscribe", { preHandler: ctx.requireAuth }, async (req) => {
    const body = SubscriptionBody.parse(req.body);
    await ctx.push.subscribe(req.user!.sub, body);
    return { ok: true };
  });

  app.post("/api/push/unsubscribe", { preHandler: ctx.requireAuth }, async (req) => {
    const body = UnsubscribeBody.parse(req.body);
    await ctx.push.unsubscribe(req.user!.sub, body.endpoint);
    return { ok: true };
  });

  const nativeLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  app.post("/api/push/native/register", { preHandler: ctx.requireAuth, ...nativeLimit }, async (req) => {
    const body = NativeRegisterBody.parse(req.body);
    await ctx.push.registerNativeToken(req.user!.sub, body);
    return { ok: true };
  });

  app.post("/api/push/native/unregister", { preHandler: ctx.requireAuth, ...nativeLimit }, async (req) => {
    const body = NativeUnregisterBody.parse(req.body);
    await ctx.push.unregisterNativeToken(req.user!.sub, body.token);
    return { ok: true };
  });
}

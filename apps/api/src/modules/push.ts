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

/**
 * Opt-in Web Push (VAPID). A user's subscriptions live in `PushSubscription`
 * (one row per browser/device, keyed by the push service's unique `endpoint`).
 * Sending is always best-effort: a failed push must never break the caller
 * (mirrors AuditService.record's must-never-break-the-primary-operation rule).
 */
export class PushService {
  private configured = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {}

  private ensureConfigured(): void {
    if (this.configured) return;
    webpush.setVapidDetails(this.config.VAPID_SUBJECT, this.config.VAPID_PUBLIC_KEY, this.config.VAPID_PRIVATE_KEY);
    this.configured = true;
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

  /** Push a small JSON payload to every device a user has opted in on. Best-effort. */
  async sendToUser(userId: string, payload: Record<string, unknown>): Promise<void> {
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
  async sendToRider(riderId: string, payload: Record<string, unknown>): Promise<void> {
    const rider = await this.prisma.rider.findUnique({ where: { id: riderId }, select: { userId: true } });
    if (rider?.userId) await this.sendToUser(rider.userId, payload);
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
}

import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import type { PrismaClient } from "@prisma/client";
import { listTemplates, TEMPLATES, type NotificationProvider, type OutboundMessage } from "@ronmacrae/notifications";
import type { QueueDriver } from "../queue/index.js";
import type { RealtimeHub } from "../rt/hub.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../lib/log.js";
import type { AuditService } from "./audit.js";
import type {
  JobEventDto,
  NotificationChannel,
  NotificationStatus,
  OutboxMessageDto,
  RiderStage,
} from "@ronmacrae/contracts";
import { roomForDispatch } from "@ronmacrae/contracts";

const TEMPLATES_SETTING_KEY = "notificationTemplates";

/** Admin-configured template-body overrides — see the Setting model. Falls
 *  back to an empty map (all defaults) on a fresh install. */
export async function getTemplateOverrides(prisma: PrismaClient): Promise<Record<string, string>> {
  const row = await prisma.setting.findUnique({ where: { key: TEMPLATES_SETTING_KEY } });
  return (row?.value as Record<string, string> | undefined) ?? {};
}

/**
 * Notification orchestrator.
 * All customer/rider messages go through the outbox:
 *   enqueue -> persisted (queued) -> queued job -> provider.send -> status
 * The realtime hub mirrors notification events to the dispatch room so the
 * dashboard shows a live message log. Works fully offline (memory provider).
 */
export class NotifyService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: NotificationProvider,
    private readonly queue: QueueDriver,
    private readonly hub: RealtimeHub,
    private readonly config: AppConfig,
    private readonly log: Logger,
    private readonly audit: AuditService,
  ) {}

  async enqueue(opts: {
    channel: Extract<NotificationChannel, "whatsapp" | "sms">;
    to: string;
    template: string;
    params: Record<string, string>;
    jobId?: string;
    /** Only for messages with no owning job (e.g. the cross-business
     *  customer-dashboard access code) — leave unset for job-linked
     *  messages, whose business is derived from the job itself below. A
     *  message that ends up with neither is a platform-level message and
     *  stays invisible to every business's staff (see list()/retry()). */
    businessId?: string;
  }): Promise<string | null> {
    const id = `nb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let businessId = opts.businessId ?? null;
    if (!businessId && opts.jobId) {
      const job = await this.prisma.job.findUnique({ where: { id: opts.jobId }, select: { businessId: true } });
      businessId = job?.businessId ?? null;
    }
    try {
      await this.prisma.outboxMessage.create({
        data: {
          id,
          channel: opts.channel,
          to: opts.to,
          template: opts.template,
          params: opts.params as object,
          jobId: opts.jobId,
          businessId,
          provider: this.provider.name,
        },
      });
    } catch (err) {
      this.log.error({ err: String(err), template: opts.template }, "outbox create failed");
      return null;
    }
    await this.queue.enqueue("notify.dispatch", { id });
    return id;
  }

  /** Queue handler - registered by the worker entry. */
  async dispatch(id: string): Promise<void> {
    const row = await this.prisma.outboxMessage.findUnique({ where: { id } });
    if (!row) return;
    // Already handed to the provider (or confirmed, or intentionally
    // skipped) — never re-dispatch, which would double-send. Only a failed
    // attempt schedules a retry (see below); "sent" waits on the provider's
    // own delivery-confirmation callback, not another dispatch from us.
    if (row.status === "sent" || row.status === "delivered" || row.status === "suppressed") return;
    if (row.attempts >= 5) {
      await this.prisma.outboxMessage.update({ where: { id }, data: { status: "failed", error: "max attempts" } });
      return;
    }
    await this.prisma.outboxMessage.update({ where: { id }, data: { status: "sending", attempts: row.attempts + 1 } });
    const templateOverrides = await getTemplateOverrides(this.prisma);
    const msg: OutboundMessage = {
      channel: row.channel as "whatsapp" | "sms",
      to: row.to,
      template: row.template,
      params: row.params as Record<string, string>,
      refId: id,
      templateOverrides,
    };
    const result = await this.provider.send(msg);
    await this.prisma.outboxMessage.update({
      where: { id },
      data: {
        status: result.status,
        providerRef: result.providerRef ?? undefined,
        error: result.error ?? undefined,
        sentAt: new Date(),
      },
    });
    if (result.status === "failed") {
      await this.queue.enqueue("notify.dispatch", { id }, { delayMs: 5 * 60_000 });
    }
    // mirror to dashboard — only the business that owns the related job, if
    // there is one (a notification not tied to any job has no business to
    // attribute it to, so it's skipped here rather than broadcast globally).
    const notifyJob = row.jobId ? await this.prisma.job.findUnique({ where: { id: row.jobId }, select: { businessId: true } }) : null;
    if (notifyJob) {
      this.hub.broadcast(roomForDispatch(notifyJob.businessId), {
        type: "notification",
        payload: {
          id,
          channel: row.channel,
          to: row.to,
          template: row.template,
          status: result.status,
          at: new Date().toISOString(),
        },
      });
    }
  }

  /** `businessId` is required, not optional — a caller who forgot to pass
   *  it should get a type error, not accidentally list every business's
   *  notifications (this is the exact bug Stage 22 found and fixed: the
   *  route previously had no business filter at all). */
  async list(filter: { businessId: string; status?: string; jobId?: string; take?: number; skip?: number }) {
    const rows = await this.prisma.outboxMessage.findMany({
      where: { businessId: filter.businessId, status: filter.status as NotificationStatus | undefined, jobId: filter.jobId },
      orderBy: { createdAt: "desc" },
      take: Math.min(filter.take ?? 100, 500),
      skip: filter.skip ?? 0,
    });
    return rows.map(toOutboxDto);
  }

  /** 404s (not the row's real state) on a businessId mismatch or a
   *  platform-level (businessId: null) message — a business must never
   *  learn that a notification id belonging to someone else, or to no
   *  business at all, exists. */
  async retry(id: string, businessId: string): Promise<void> {
    const row = await this.prisma.outboxMessage.findUnique({ where: { id } });
    if (!row || row.businessId !== businessId) {
      throw httpErrors.createError(404, "Notification not found");
    }
    await this.prisma.outboxMessage.update({ where: { id }, data: { status: "queued", attempts: 0, error: null } });
    await this.queue.enqueue("notify.dispatch", { id });
  }
}

export function toOutboxDto(r: {
  id: string;
  channel: string;
  to: string;
  template: string;
  params: unknown;
  jobId: string | null;
  status: string;
  provider: string;
  providerRef: string | null;
  error: string | null;
  attempts: number;
  scheduledAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
}): OutboxMessageDto {
  return {
    id: r.id,
    channel: r.channel as OutboxMessageDto["channel"],
    to: r.to,
    template: r.template,
    params: (r.params as Record<string, string>) ?? {},
    jobId: r.jobId,
    status: r.status as OutboxMessageDto["status"],
    provider: r.provider,
    providerRef: r.providerRef,
    error: r.error,
    attempts: r.attempts,
    scheduledAt: r.scheduledAt?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// High-level job notifications (used by the jobs module)
// ---------------------------------------------------------------------------

export interface JobNotifyContext {
  job: {
    id: string;
    externalRef: string | null;
    customerName: string;
    customerPhone: string;
    failureReason: string | null;
    routeEta: string | null;
    completedAt: string | null;
  };
  linkUrl: string | null;
  riderName: string | null;
  business: string;
  dispatchPhone: string;
}

/** Both `riderName` and `courierName` carry the same value — the shipped
 *  default template bodies (packages/notifications/src/core.ts) reference
 *  `{{courierName}}` (Task B: courier-branded customer-facing wording),
 *  but an admin's already-customized override might still use the old
 *  `{{riderName}}` placeholder, so both keys are always supplied. See
 *  `TemplateDef`'s doc comment in core.ts for the full rationale. */
function courierNameParams(name: string | null, fallback: string): { riderName: string; courierName: string } {
  const value = name ?? fallback;
  return { riderName: value, courierName: value };
}

export class JobNotifier {
  constructor(private readonly notify: NotifyService) {}

  async forJobEvent(evt: JobEventDto, ctxJob: JobNotifyContext): Promise<void> {
    const { job } = ctxJob;
    const customer = { customerName: job.customerName, orderRef: job.externalRef ?? job.id, business: ctxJob.business, dispatchPhone: ctxJob.dispatchPhone, trackingUrl: ctxJob.linkUrl ?? "" };
    const base: Record<string, string> = { ...customer };
    const channel = "whatsapp" as const;
    switch (evt.to) {
      case "assigned":
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "rider_assigned", params: { ...base, ...courierNameParams(ctxJob.riderName, "a courier") }, jobId: job.id });
        break;
      case "picked_up":
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "picked_up", params: base, jobId: job.id });
        break;
      case "in_transit":
        // "in transit" and "near destination" (below) are distinct lifecycle
        // events with their own messages — a customer told "on the way, ETA
        // soon" and then later "your rider is right outside" are two
        // different, useful signals, not the same one repeated.
        await this.notify.enqueue({
          channel,
          to: job.customerPhone,
          template: "out_for_delivery",
          params: { ...base, ...courierNameParams(ctxJob.riderName, ""), eta: job.routeEta ? new Date(job.routeEta).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "soon" },
          jobId: job.id,
        });
        break;
      case "delivering":
        await this.notify.enqueue({
          channel,
          to: job.customerPhone,
          template: "near_destination",
          params: { ...base, ...courierNameParams(ctxJob.riderName, "your courier") },
          jobId: job.id,
        });
        break;
      case "delivered":
        await this.notify.enqueue({
          channel,
          to: job.customerPhone,
          template: "delivered",
          params: { ...base, deliveredAt: job.completedAt ? new Date(job.completedAt).toLocaleString("en-GB") : "just now" },
          jobId: job.id,
        });
        break;
      case "failed":
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "failed", params: { ...base, failureReason: job.failureReason ?? "an issue" }, jobId: job.id });
        break;
      case "no_answer":
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "no_answer", params: base, jobId: job.id });
        break;
      case "location_changed":
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "location_changed", params: { ...base, ...courierNameParams(ctxJob.riderName, "your courier") }, jobId: job.id });
        break;
      case "returned":
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "returned", params: base, jobId: job.id });
        break;
      case "cancelled":
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "cancelled", params: base, jobId: job.id });
        break;
      case "new": // requeue (a fresh attempt after a failed/no-answer one)
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "requeued", params: base, jobId: job.id });
        break;
      default:
        break;
    }
  }

  /** Rider stage changes (heading_to_pickup/at_pickup/heading_to_dropoff)
   *  aren't job-status transitions, so they don't go through forJobEvent —
   *  called separately from recordRiderStage() for the one stage that's
   *  customer-visible ("heading to pickup" — spec 5D's own event list). */
  async forRiderStage(stage: RiderStage, ctxJob: JobNotifyContext): Promise<void> {
    if (stage !== "heading_to_pickup") return;
    const { job } = ctxJob;
    await this.notify.enqueue({
      channel: "whatsapp",
      to: job.customerPhone,
      template: "heading_to_pickup",
      params: {
        customerName: job.customerName,
        orderRef: job.externalRef ?? job.id,
        business: ctxJob.business,
        dispatchPhone: ctxJob.dispatchPhone,
        trackingUrl: ctxJob.linkUrl ?? "",
        ...courierNameParams(ctxJob.riderName, "your courier"),
      },
      jobId: job.id,
    });
  }

  /** The very first customer notification: order placed, tracking link ready.
   *  Called once, the first time a job gets a tracking link (see
   *  history.ts's createTrackingLink) — never repeated on a later
   *  link refresh, which isn't a new order. */
  async forOrderCreated(ctxJob: JobNotifyContext & { ttlHours: number }): Promise<void> {
    const { job } = ctxJob;
    await this.notify.enqueue({
      channel: "whatsapp",
      to: job.customerPhone,
      template: "order_confirmed",
      params: {
        customerName: job.customerName,
        orderRef: job.externalRef ?? job.id,
        business: ctxJob.business,
        dispatchPhone: ctxJob.dispatchPhone,
        trackingUrl: ctxJob.linkUrl ?? "",
        ttl: `${ctxJob.ttlHours}h`,
      },
      jobId: job.id,
    });
  }
}

const ListQuery = z.object({
  status: z.enum(["queued", "sending", "sent", "delivered", "failed", "suppressed"]).optional(),
  jobId: z.string().optional(),
  take: z.coerce.number().int().min(1).max(500).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export async function notificationRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/notifications", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    const q = ListQuery.parse(req.query);
    return { messages: await ctx.notify.list({ ...q, businessId: req.user!.businessId! }), provider: ctx.notifier.name };
  });

  app.get("/api/notifications/provider", { preHandler: ctx.requireStaff("admin") }, async () => ({
    provider: ctx.notifier.name,
    channels: [...ctx.notifier.channels],
  }));

  app.post<{ Params: { id: string } }>("/api/notifications/:id/retry", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    await ctx.notify.retry(req.params.id, req.user!.businessId!);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "notification.retry", "notification", req.params.id);
    return { ok: true };
  });

  // Configurable message templates (spec 5D). Every template has a built-in
  // default (packages/notifications) so the system is fully usable with none
  // of this ever touched; an override here changes only its text, never
  // which event triggers it or what channel it goes out on.
  app.get("/api/notifications/templates", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async () => {
    const overrides = await getTemplateOverrides(ctx.prisma);
    return { templates: listTemplates(overrides) };
  });

  app.put("/api/notifications/templates", { preHandler: ctx.requireStaff("admin") }, async (req) => {
    const body = z.object({ templates: z.record(z.string(), z.string().max(1000)) }).parse(req.body);
    const unknown = Object.keys(body.templates).filter((name) => !(name in TEMPLATES));
    if (unknown.length > 0) throw httpErrors.createError(400, `Unknown template name(s): ${unknown.join(", ")}`);
    // Merges into the existing override map rather than replacing it wholesale
    // — saving one template's new wording must never silently wipe out
    // another template's already-saved override. Blank entries fall back to
    // the built-in default (see effectiveTemplateBody).
    const existing = await getTemplateOverrides(ctx.prisma);
    const merged = { ...existing, ...body.templates };
    await ctx.prisma.setting.upsert({
      where: { key: TEMPLATES_SETTING_KEY },
      create: { key: TEMPLATES_SETTING_KEY, value: merged },
      update: { value: merged },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "notification.templates_update", "setting", TEMPLATES_SETTING_KEY, { names: Object.keys(body.templates) });
    return { templates: listTemplates(merged) };
  });

  // Twilio's delivery-status webhook (see twilio.ts's send() and its own
  // activation-steps comment) — the only thing that ever moves a message
  // from "sent" to a confirmed "delivered"/"failed". Public (Twilio calls
  // it directly, unauthenticated) but signature-verified whenever
  // TWILIO_AUTH_TOKEN is configured; without one (dev/test/no real account
  // yet) it's accepted unverified, since there's nothing to verify against.
  app.post("/api/notifications/twilio-status", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const body = req.body as Record<string, string> | undefined;
    const sid = body?.MessageSid;
    const twilioStatus = body?.MessageStatus;
    if (!sid || !twilioStatus) {
      throw httpErrors.createError(400, "Missing MessageSid/MessageStatus");
    }
    if (ctx.config.TWILIO_AUTH_TOKEN) {
      const signature = req.headers["x-twilio-signature"];
      const url = `${ctx.config.APP_ORIGIN}/api/notifications/twilio-status`;
      if (typeof signature !== "string" || !verifyTwilioSignature(ctx.config.TWILIO_AUTH_TOKEN, url, body ?? {}, signature)) {
        throw httpErrors.createError(403, "Invalid Twilio signature");
      }
    }
    const row = await ctx.prisma.outboxMessage.findFirst({ where: { providerRef: sid } });
    if (!row) return { ok: true }; // unknown/foreign message id — nothing to update, not an error
    const nextStatus: NotificationStatus | null =
      twilioStatus === "delivered" ? "delivered" : twilioStatus === "failed" || twilioStatus === "undelivered" ? "failed" : null;
    if (nextStatus) {
      await ctx.prisma.outboxMessage.update({ where: { id: row.id }, data: { status: nextStatus, error: nextStatus === "failed" ? `Twilio: ${twilioStatus}` : null } });
      const webhookJob = row.jobId ? await ctx.prisma.job.findUnique({ where: { id: row.jobId }, select: { businessId: true } }) : null;
      if (webhookJob) {
        ctx.hub.broadcast(roomForDispatch(webhookJob.businessId), { type: "notification", payload: { id: row.id, channel: row.channel, to: row.to, template: row.template, status: nextStatus, at: new Date().toISOString() } });
      }
    }
    return { ok: true };
  });
}

/** Twilio signs each webhook request with HMAC-SHA1 over the full callback
 *  URL plus every POST param (sorted, concatenated key+value), base64-encoded,
 *  compared to the X-Twilio-Signature header. Constant-time compare to avoid
 *  a timing side-channel. */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

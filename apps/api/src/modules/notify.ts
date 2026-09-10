import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppCtx } from "../ctx.js";
import type { PrismaClient } from "@prisma/client";
import type { NotificationProvider, OutboundMessage } from "@ronmacrae/notifications";
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
} from "@ronmacrae/contracts";
import { ROOM_DISPATCH } from "@ronmacrae/contracts";

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
  }): Promise<string | null> {
    const id = `nb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await this.prisma.outboxMessage.create({
        data: {
          id,
          channel: opts.channel,
          to: opts.to,
          template: opts.template,
          params: opts.params as object,
          jobId: opts.jobId,
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
    if (row.status === "delivered" || row.status === "suppressed") return;
    if (row.attempts >= 5) {
      await this.prisma.outboxMessage.update({ where: { id }, data: { status: "failed", error: "max attempts" } });
      return;
    }
    await this.prisma.outboxMessage.update({ where: { id }, data: { status: "sending", attempts: row.attempts + 1 } });
    const msg: OutboundMessage = {
      channel: row.channel as "whatsapp" | "sms",
      to: row.to,
      template: row.template,
      params: row.params as Record<string, string>,
      refId: id,
    };
    const result = await this.provider.send(msg);
    await this.prisma.outboxMessage.update({
      where: { id },
      data: {
        status: result.status === "delivered" ? "delivered" : "failed",
        providerRef: result.providerRef ?? undefined,
        error: result.error ?? undefined,
        sentAt: new Date(),
      },
    });
    if (result.status !== "delivered") {
      await this.queue.enqueue("notify.dispatch", { id }, { delayMs: 5 * 60_000 });
    }
    // mirror to dashboard
    this.hub.broadcast(ROOM_DISPATCH, {
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

  async list(filter: { status?: string; jobId?: string; take?: number; skip?: number }) {
    const rows = await this.prisma.outboxMessage.findMany({
      where: { status: filter.status as NotificationStatus | undefined, jobId: filter.jobId },
      orderBy: { createdAt: "desc" },
      take: Math.min(filter.take ?? 100, 500),
      skip: filter.skip ?? 0,
    });
    return rows.map(toOutboxDto);
  }

  async retry(id: string): Promise<void> {
    const row = await this.prisma.outboxMessage.findUnique({ where: { id } });
    if (!row) return;
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

export class JobNotifier {
  constructor(private readonly notify: NotifyService) {}

  async forJobEvent(evt: JobEventDto, ctxJob: JobNotifyContext): Promise<void> {
    const { job } = ctxJob;
    const customer = { customerName: job.customerName, orderRef: job.externalRef ?? job.id, business: ctxJob.business, dispatchPhone: ctxJob.dispatchPhone, trackingUrl: ctxJob.linkUrl ?? "" };
    const base: Record<string, string> = { ...customer };
    const channel = "whatsapp" as const;
    switch (evt.to) {
      case "assigned":
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "rider_assigned", params: { ...base, riderName: ctxJob.riderName ?? "a courier" }, jobId: job.id });
        break;
      case "picked_up":
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "picked_up", params: base, jobId: job.id });
        break;
      case "in_transit":
      case "delivering":
        await this.notify.enqueue({
          channel,
          to: job.customerPhone,
          template: "out_for_delivery",
          params: { ...base, riderName: ctxJob.riderName ?? "", eta: job.routeEta ? new Date(job.routeEta).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "soon" },
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
        await this.notify.enqueue({ channel, to: job.customerPhone, template: "location_changed", params: { ...base, riderName: ctxJob.riderName ?? "your courier" }, jobId: job.id });
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
}

const ListQuery = z.object({
  status: z.enum(["queued", "sending", "delivered", "failed", "suppressed"]).optional(),
  jobId: z.string().optional(),
  take: z.coerce.number().int().min(1).max(500).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export async function notificationRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/notifications", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    const q = ListQuery.parse(req.query);
    return { messages: await ctx.notify.list(q), provider: ctx.notifier.name };
  });

  app.get("/api/notifications/provider", { preHandler: ctx.requireStaff("admin") }, async () => ({
    provider: ctx.notifier.name,
    channels: [...ctx.notifier.channels],
  }));

  app.post<{ Params: { id: string } }>("/api/notifications/:id/retry", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    await ctx.notify.retry(req.params.id);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "notification.retry", "notification", req.params.id);
    return { ok: true };
  });
}

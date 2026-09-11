import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppCtx } from "../ctx.js";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../lib/log.js";
import type { AuditEntryDto } from "@ronmacrae/contracts";

/** Append-only audit trail for every privileged mutation. */
export class AuditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: Logger,
  ) {}

  async record(
    actor: { id: string | null; role: string | null },
    action: string,
    entityType: string,
    entityId?: string | null,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const businessId = entityId ? await this.deriveBusinessId(entityType, entityId) : null;
      await this.prisma.auditLog.create({
        data: {
          userId: actor.id ?? undefined,
          role: actor.role ?? undefined,
          action,
          entityType,
          entityId: entityId ?? undefined,
          businessId,
          meta: meta as object,
        },
      });
    } catch (err) {
      // auditing must never break the primary operation
      this.log.error({ err: String(err), action }, "audit write failed");
    }
  }

  /** job/customer/offer entities carry a businessId (directly, or one hop
   *  away); rider/user/customerIdentity entities are genuinely global (a
   *  rider being created, a staff login, an identity merge spanning
   *  businesses by design) — null for those is correct, not a gap. */
  private async deriveBusinessId(entityType: string, entityId: string): Promise<string | null> {
    switch (entityType) {
      case "job": {
        const job = await this.prisma.job.findUnique({ where: { id: entityId }, select: { businessId: true } });
        return job?.businessId ?? null;
      }
      case "customer": {
        const customer = await this.prisma.customer.findUnique({ where: { id: entityId }, select: { businessId: true } });
        return customer?.businessId ?? null;
      }
      case "offer": {
        const offer = await this.prisma.jobOffer.findUnique({ where: { id: entityId }, select: { businessId: true } });
        return offer?.businessId ?? null;
      }
      default:
        return null;
    }
  }

  /** Omitting `businessId` returns platform-wide, unscoped entries — only
   *  ever call this without one from an owner-gated route (see
   *  requireOwner). The per-business route always passes one. */
  async list(filter: {
    businessId?: string;
    entityType?: string;
    entityId?: string;
    action?: string;
    from?: string;
    to?: string;
    take?: number;
    skip?: number;
  }) {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        businessId: filter.businessId,
        entityType: filter.entityType,
        entityId: filter.entityId,
        action: filter.action,
        at: {
          ...(filter.from ? { gte: new Date(filter.from) } : {}),
          ...(filter.to ? { lte: new Date(filter.to) } : {}),
        },
      },
      orderBy: { at: "desc" },
      take: Math.min(filter.take ?? 100, 500),
      skip: filter.skip ?? 0,
      include: { user: { select: { name: true, role: true } } },
    });
    return rows.map((r): AuditEntryDto => ({
      id: r.id,
      actorId: r.userId,
      actorName: r.user?.name ?? null,
      role: r.role as AuditEntryDto["role"],
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      ip: r.ip,
      meta: (r.meta as Record<string, unknown>) ?? null,
      at: r.at.toISOString(),
    }));
  }
}

const ListQuery = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  action: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  take: z.coerce.number().int().min(1).max(500).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export async function auditRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  // Business-scoped: a real bug found in Stage 23 — this route had no
  // business filter at all, so any staff member at any business could
  // read every other business's entire audit trail. Every entry with no
  // businessId (rider/user/global events) is correctly invisible here too,
  // not just other businesses' — see the owner-only route below for those.
  app.get("/api/audit", { preHandler: ctx.requireStaff("admin", "accountant", "viewer") }, async (req) => {
    const q = ListQuery.parse(req.query);
    return { entries: await ctx.audit.list({ ...q, businessId: req.user!.businessId! }) };
  });

  // Platform-wide, unscoped — the first real use of requireOwner (closing a
  // documented gap from Stage 20: "no owner-console UI... yet"). Sees
  // everything: every business's own events plus the genuinely global ones
  // (rider creation, staff logins, customer-identity merges).
  app.get("/api/owner/audit", { preHandler: ctx.requireOwner }, async (req) => {
    const q = ListQuery.parse(req.query);
    return { entries: await ctx.audit.list(q) };
  });
}

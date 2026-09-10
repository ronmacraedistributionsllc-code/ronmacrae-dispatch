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
      await this.prisma.auditLog.create({
        data: {
          userId: actor.id ?? undefined,
          role: actor.role ?? undefined,
          action,
          entityType,
          entityId: entityId ?? undefined,
          meta: meta as object,
        },
      });
    } catch (err) {
      // auditing must never break the primary operation
      this.log.error({ err: String(err), action }, "audit write failed");
    }
  }

  async list(filter: {
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
  app.get("/api/audit", { preHandler: ctx.requireStaff("admin", "accountant", "viewer") }, async (req) => {
    const q = ListQuery.parse(req.query);
    return { entries: await ctx.audit.list(q) };
  });
}

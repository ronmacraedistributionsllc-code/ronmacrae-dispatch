import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { money, sum } from "@ronmacrae/money";
import type { SettlementDto, SettlementType } from "@ronmacrae/contracts";
import { actorType } from "./jobs/dto.js";

/**
 * Rider-to-office cash settlements, batched per merchant (spec section 42:
 * "SETTLEMENTS" / section 90: "END-OF-DAY RIDER RECONCILIATION"). A
 * settlement both records its own ledger entry (who received how much,
 * when, covering which jobs) AND moves each covered job's own COD status
 * from `handed_in` to `approved` — the same effect the existing per-job
 * "Approve cash drop-off" action has, just batched across every job (or a
 * chosen subset) for one rider+merchant pair at once. The amount is always
 * computed server-side from the jobs actually being settled — never
 * trusted from the request, same "never trust money the client tells you"
 * rule as order pricing.
 */

type OutstandingRow = {
  id: string;
  jobNumber: string | null;
  merchantId: string | null;
  merchantName: string | null;
  codHandedInAmount: number | null;
  amountCollected: number | null;
  currency: string;
};

async function outstandingJobsFor(ctx: AppCtx, businessId: string, riderId: string) {
  const rows = await ctx.prisma.job.findMany({
    where: { riderId, businessId, paymentMethod: "cod", codStatus: "handed_in" },
    select: {
      id: true,
      jobNumber: true,
      merchantId: true,
      merchant: { select: { name: true } },
      codHandedInAmount: true,
      amountCollected: true,
      currency: true,
    },
    orderBy: { codHandoverAt: "asc" },
  });
  return rows.map((r): OutstandingRow => ({
    id: r.id,
    jobNumber: r.jobNumber,
    merchantId: r.merchantId,
    merchantName: r.merchant?.name ?? null,
    codHandedInAmount: r.codHandedInAmount,
    amountCollected: r.amountCollected,
    currency: r.currency,
  }));
}

function settlementAmountFor(job: OutstandingRow): number {
  return job.codHandedInAmount ?? job.amountCollected ?? 0;
}

const CreateSettlement = z.object({
  riderId: z.string().min(1),
  merchantId: z.string().min(1).optional().nullable(),
  type: z.enum(["full", "partial"]).default("full"),
  jobIds: z.array(z.string().min(1)).min(1).max(200),
  reference: z.string().max(120).optional().or(z.literal("")).nullable(),
  note: z.string().max(500).optional().or(z.literal("")).nullable(),
});

export async function settlementRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const staff = ctx.requireStaff("admin", "dispatcher", "accountant");

  // Admin picks a rider, sees exactly what's outstanding and whose it is —
  // spec section 42's "System shows outstanding balances by merchant."
  app.get<{ Params: { riderId: string } }>(
    "/api/riders/:riderId/settlements/outstanding",
    { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") },
    async (req) => {
      const businessId = req.user!.businessId!;
      const membership = await ctx.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId: req.params.riderId, businessId } } });
      if (!membership) throw httpErrors.createError(404, "Courier not found");
      const jobs = await outstandingJobsFor(ctx, businessId, req.params.riderId);
      const groups = new Map<string | null, { merchantName: string; jobs: OutstandingRow[] }>();
      for (const job of jobs) {
        const key = job.merchantId;
        const existing = groups.get(key);
        if (existing) existing.jobs.push(job);
        else groups.set(key, { merchantName: job.merchantName ?? "Direct orders", jobs: [job] });
      }
      return {
        merchants: [...groups.entries()].map(([merchantId, { merchantName, jobs: mJobs }]) => ({
          merchantId,
          merchantName,
          total: sum(mJobs.map((j) => money(settlementAmountFor(j), j.currency))),
          jobs: mJobs.map((j) => ({ jobId: j.id, jobNumber: j.jobNumber, amount: money(settlementAmountFor(j), j.currency) })),
        })),
      };
    },
  );

  app.get("/api/settlements", { preHandler: staff }, async (req) => {
    const q = z.object({ riderId: z.string().optional(), merchantId: z.string().optional(), take: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const rows = await ctx.prisma.settlement.findMany({
      where: { businessId: req.user!.businessId!, riderId: q.riderId, merchantId: q.merchantId },
      include: { rider: true, merchant: true, receivedBy: true, lines: true },
      orderBy: { createdAt: "desc" },
      take: q.take,
    });
    return { settlements: rows.map(toDto) };
  });

  app.post("/api/settlements", { preHandler: staff }, async (req) => {
    const body = CreateSettlement.parse(req.body);
    const businessId = req.user!.businessId!;
    const actor = { id: req.user!.sub, name: req.user!.name, role: req.user!.role };

    const membership = await ctx.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId: body.riderId, businessId } } });
      if (!membership) throw httpErrors.createError(404, "Courier not found");
    if (body.merchantId) {
      const merchant = await ctx.prisma.merchant.findFirst({ where: { id: body.merchantId, businessId } });
      if (!merchant) throw httpErrors.createError(404, "Merchant not found");
    }

    const jobs = await ctx.prisma.job.findMany({
      where: { id: { in: body.jobIds }, riderId: body.riderId, businessId, paymentMethod: "cod", codStatus: "handed_in", merchantId: body.merchantId ?? null },
    });
    if (jobs.length !== body.jobIds.length) {
      throw httpErrors.createError(409, "One or more of these orders are no longer eligible to settle (already settled, or not this courier/merchant) — refresh and try again");
    }
    if (jobs.length === 0) throw httpErrors.createError(400, "No orders to settle");

    const cur = jobs[0]!.currency;
    const totalMinor = jobs.reduce((s, j) => s + (j.codHandedInAmount ?? j.amountCollected ?? 0), 0);

    const settlement = await ctx.prisma.$transaction(async (tx) => {
      const created = await tx.settlement.create({
        data: {
          businessId,
          riderId: body.riderId,
          merchantId: body.merchantId ?? null,
          amount: totalMinor,
          currency: cur,
          type: body.type as SettlementType,
          receivedById: req.user!.sub,
          reference: body.reference || null,
          note: body.note || null,
          lines: { create: jobs.map((j) => ({ jobId: j.id, amount: j.codHandedInAmount ?? j.amountCollected ?? 0 })) },
        },
        include: { rider: true, merchant: true, receivedBy: true, lines: true },
      });
      for (const job of jobs) {
        await tx.job.update({
          where: { id: job.id },
          data: { codStatus: "approved", codApprovedById: req.user!.sub, codApprovedAt: new Date() },
        });
        await tx.codEvent.create({
          data: {
            jobId: job.id,
            from: "handed_in",
            to: "approved",
            actorType: actorType(req.user!.role),
            actorId: req.user!.sub,
            actorName: req.user!.name,
            note: `Settled via ${created.id}`,
            meta: { settlementId: created.id } as object,
          },
        });
      }
      return created;
    });

    await ctx.audit.record(actor, "settlement.create", "settlement", settlement.id, { riderId: body.riderId, merchantId: body.merchantId ?? null, amountMinor: totalMinor, jobCount: jobs.length });
    return { settlement: toDto(settlement) };
  });
}

type SettlementRow = {
  id: string;
  businessId: string;
  riderId: string;
  rider: { name: string };
  merchantId: string | null;
  merchant: { name: string } | null;
  amount: number;
  currency: string;
  type: string;
  receivedById: string;
  receivedBy: { name: string };
  reference: string | null;
  note: string | null;
  createdAt: Date;
  lines: { jobId: string }[];
};

function toDto(s: SettlementRow): SettlementDto {
  return {
    id: s.id,
    businessId: s.businessId,
    riderId: s.riderId,
    riderName: s.rider.name,
    merchantId: s.merchantId,
    merchantName: s.merchant?.name ?? null,
    amount: money(s.amount, s.currency),
    type: s.type as SettlementType,
    receivedById: s.receivedById,
    receivedByName: s.receivedBy.name,
    reference: s.reference,
    note: s.note,
    jobIds: s.lines.map((l) => l.jobId),
    createdAt: s.createdAt.toISOString(),
  };
}

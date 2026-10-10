import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { FastifyRequest } from "fastify";
import type { AppCtx } from "../ctx.js";
import type { PrismaClient } from "../prisma.js";
import { minorOf } from "@ronmacrae/money";
import type { Actor } from "./jobs/index.js";

const actorFor = (req: FastifyRequest): Actor => ({ id: req.user!.sub, name: req.user!.name, role: req.user!.role, riderId: req.user!.riderId, businessId: req.user!.businessId });

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Dual-confirmation money ledger — "who owes what, and did BOTH sides
 * agree". A transfer is never complete until the payer confirms "I paid"
 * AND the receiver confirms "I received". One-sided states stay visible
 * in the reconciliation queue; disputes freeze until resolved. This
 * complements the COD collected/handed_in/approved flow (which feeds it:
 * hand-in marks payer-confirmed, approval marks receiver-confirmed) and
 * covers what that flow never did — business→courier payouts and
 * business→merchant settlements, which previously had no tracking at all.
 */

const CreateBody = z.object({
  kind: z.enum(["courier_payout", "merchant_settlement"]),
  toRiderId: z.string().optional(),
  toMerchantId: z.string().optional(),
  jobId: z.string().optional(),
  amount: z.number().positive().max(10_000_000),
  note: z.string().max(300).optional().or(z.literal("")).nullable(),
});

const ConfirmBody = z.object({
  side: z.enum(["paid", "received"]),
  note: z.string().max(300).optional().or(z.literal("")).nullable(),
});

const DisputeBody = z.object({ note: z.string().min(1).max(300) });

/** Auto-created on COD delivery: rider collected cash, owes the business. */
export async function ensureCodHandoverTransfer(
  tx: Tx,
  job: { id: string; businessId: string; riderId: string | null; amountCollected: number | null; currency: string },
): Promise<void> {
  if (!job.riderId || (job.amountCollected ?? 0) <= 0) return;
  const existing = await tx.moneyTransfer.findFirst({ where: { jobId: job.id, kind: "cod_handover" } });
  if (existing) return;
  await tx.moneyTransfer.create({
    data: {
      businessId: job.businessId,
      jobId: job.id,
      kind: "cod_handover",
      amount: job.amountCollected ?? 0,
      currency: job.currency,
      fromKind: "rider",
      fromRiderId: job.riderId,
      toKind: "business",
      note: "Cash collected on delivery — awaiting handover",
    },
  });
}

async function touchTransferSide(
  db: Tx | PrismaClient,
  transferId: string,
  side: "paid" | "received",
  byUserId: string,
  note?: string | null,
): Promise<{ status: string }> {
  const row = await db.moneyTransfer.findUnique({ where: { id: transferId } });
  if (!row) throw httpErrors.createError(404, "Transfer not found");
  if (row.status === "confirmed") throw httpErrors.createError(409, "Already confirmed by both sides");
  if (row.status === "disputed") throw httpErrors.createError(409, "Disputed — resolve the dispute first");
  const patch =
    side === "paid"
      ? { payerConfirmedAt: row.payerConfirmedAt ?? new Date(), payerConfirmedById: row.payerConfirmedById ?? byUserId }
      : { receiverConfirmedAt: row.receiverConfirmedAt ?? new Date(), receiverConfirmedById: row.receiverConfirmedById ?? byUserId };
  const next = await db.moneyTransfer.update({ where: { id: transferId }, data: { ...patch, ...(note ? { note } : {}) } });
  if (next.payerConfirmedAt && next.receiverConfirmedAt && next.status !== "confirmed") {
    await db.moneyTransfer.update({ where: { id: transferId }, data: { status: "confirmed" } });
    return { status: "confirmed" };
  }
  if (next.status === "pending" && (next.payerConfirmedAt || next.receiverConfirmedAt)) {
    await db.moneyTransfer.update({ where: { id: transferId }, data: { status: "awaiting_other_side" } });
    return { status: "awaiting_other_side" };
  }
  return { status: next.status };
}

/** COD handover recorded (rider says "I handed this in") → payer half. */
export async function markCodHandoverPaid(
  tx: Tx,
  job: { id: string; businessId: string; riderId: string | null; amount: number; currency: string },
  byUserId: string,
): Promise<void> {
  let t = await tx.moneyTransfer.findFirst({ where: { jobId: job.id, kind: "cod_handover" } });
  if (!t) {
    t = await tx.moneyTransfer.create({
      data: { businessId: job.businessId, jobId: job.id, kind: "cod_handover", amount: job.amount, currency: job.currency, fromKind: "rider", fromRiderId: job.riderId, toKind: "business" },
    });
  }
  if (t.status === "confirmed" || t.status === "disputed") return;
  const next = await tx.moneyTransfer.update({ where: { id: t.id }, data: { payerConfirmedAt: t.payerConfirmedAt ?? new Date(), payerConfirmedById: t.payerConfirmedById ?? byUserId } });
  if (next.payerConfirmedAt && next.receiverConfirmedAt) {
    await tx.moneyTransfer.update({ where: { id: t.id }, data: { status: "confirmed" } });
  } else if (next.status === "pending") {
    await tx.moneyTransfer.update({ where: { id: t.id }, data: { status: "awaiting_other_side" } });
  }
}

/** COD approved (office says "received") → receiver half completes it. */
export async function markCodHandoverReceived(tx: Tx, jobId: string, byUserId: string): Promise<void> {
  const t = await tx.moneyTransfer.findFirst({ where: { jobId, kind: "cod_handover" } });
  if (!t || t.status === "confirmed" || t.status === "disputed") return;
  await tx.moneyTransfer.update({
    where: { id: t.id },
    data: { receiverConfirmedAt: t.receiverConfirmedAt ?? new Date(), receiverConfirmedById: t.receiverConfirmedById ?? byUserId, status: "confirmed" },
  });
}

/** COD disputed → freeze the money trail until resolved. */
export async function disputeCodTransfer(tx: Tx, jobId: string): Promise<void> {
  const t = await tx.moneyTransfer.findFirst({ where: { jobId, kind: "cod_handover" } });
  if (!t || t.status === "confirmed" || t.status === "disputed") return;
  await tx.moneyTransfer.update({ where: { id: t.id }, data: { status: "disputed" } });
}

/** Caller identity for side checks: own rider row, staff business, merchant rows. */
async function callerSides(ctx: AppCtx, req: FastifyRequest) {
  const riderId = req.user?.riderId ?? null;
  const businessId = req.user?.businessId ?? null;
  const merchantIds =
    req.user && !riderId
      ? (await ctx.prisma.merchantStaff.findMany({ where: { userId: req.user.sub }, select: { merchantId: true } })).map((m) => m.merchantId)
      : [];
  return { riderId, businessId, merchantIds };
}

function sideMatches(
  side: "paid" | "received",
  t: { fromKind: string; fromRiderId: string | null; fromMerchantId: string | null; toKind: string; toRiderId: string | null; toMerchantId: string | null; businessId: string },
  who: { riderId: string | null; businessId: string | null; merchantIds: string[] },
): boolean {
  if (side === "paid") {
    if (t.fromKind === "rider") return who.riderId === t.fromRiderId;
    if (t.fromKind === "business") return who.businessId === t.businessId;
    if (t.fromKind === "merchant") return t.fromMerchantId != null && who.merchantIds.includes(t.fromMerchantId);
    return false;
  }
  if (t.toKind === "rider") return who.riderId === t.toRiderId;
  if (t.toKind === "business") return who.businessId === t.businessId;
  if (t.toKind === "merchant") return t.toMerchantId != null && who.merchantIds.includes(t.toMerchantId);
  return false;
}

export async function moneyTransferRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  // Staff view: this business's whole ledger (who owes what), filterable.
  app.get("/api/money-transfers", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant") }, async (req) => {
    const q = req.query as { status?: string; kind?: string; riderId?: string };
    const rows = await ctx.prisma.moneyTransfer.findMany({
      where: {
        businessId: req.user!.businessId!,
        ...(q.status ? { status: q.status as "pending" | "awaiting_other_side" | "confirmed" | "disputed" } : {}),
        ...(q.kind ? { kind: q.kind as "cod_handover" | "courier_payout" | "merchant_settlement" } : {}),
        ...(q.riderId ? { OR: [{ fromRiderId: q.riderId }, { toRiderId: q.riderId }] } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        fromRider: { select: { id: true, name: true } },
        toRider: { select: { id: true, name: true } },
        job: { select: { id: true, jobNumber: true } },
      },
    });
    return { transfers: rows };
  });

  // Rider view: only transfers where I'm a party — what I owe, what's
  // owed to me, what's awaiting my confirmation either way.
  app.get("/api/bearer/money-transfers", { preHandler: ctx.requireRider }, async (req) => {
    const riderId = req.user!.riderId!;
    const rows = await ctx.prisma.moneyTransfer.findMany({
      where: { OR: [{ fromRiderId: riderId }, { toRiderId: riderId }] },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { job: { select: { id: true, jobNumber: true } } },
    });
    return { transfers: rows };
  });

  // Staff creates payouts (business → courier) and settlements
  // (business → merchant). The business is the payer; creation itself is
  // NOT confirmation — someone still has to tap "I paid".
  app.post("/api/money-transfers", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant") }, async (req) => {
    const body = CreateBody.parse(req.body);
    const businessId = req.user!.businessId!;
    if (body.kind === "courier_payout" && !body.toRiderId) throw httpErrors.createError(400, "Choose the courier to pay");
    if (body.kind === "merchant_settlement" && !body.toMerchantId) throw httpErrors.createError(400, "Choose the merchant to settle with");
    if (body.toRiderId) {
      const member = await ctx.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId: body.toRiderId, businessId } } });
      if (!member) throw httpErrors.createError(404, "That courier isn't connected to your business");
    }
    if (body.toMerchantId) {
      const merchant = await ctx.prisma.merchant.findFirst({ where: { id: body.toMerchantId, businessId } });
      if (!merchant) throw httpErrors.createError(404, "Merchant not found");
    }
    const business = await ctx.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    const row = await ctx.prisma.moneyTransfer.create({
      data: {
        businessId,
        jobId: body.jobId ?? null,
        kind: body.kind,
        amount: minorOf(body.amount, business.operationalCurrency),
        currency: business.operationalCurrency,
        fromKind: "business",
        toKind: body.kind === "courier_payout" ? "rider" : "merchant",
        toRiderId: body.toRiderId ?? null,
        toMerchantId: body.toMerchantId ?? null,
        note: body.note || null,
      },
    });
    await ctx.audit.record(actorFor(req), "money.transfer_create", "money_transfer", row.id, { kind: row.kind, amount: row.amount });
    return { transfer: row };
  });

  // Either side confirms their half. Idempotent: re-confirming your own
  // half returns ok without moving timestamps.
  app.post<{ Params: { id: string } }>("/api/money-transfers/:id/confirm", { preHandler: ctx.requireAuth }, async (req) => {
    const body = ConfirmBody.parse(req.body);
    const t = await ctx.prisma.moneyTransfer.findUnique({ where: { id: req.params.id } });
    if (!t) throw httpErrors.createError(404, "Transfer not found");
    const who = await callerSides(ctx, req);
    // Staff of the owning business may confirm the business's half;
    // riders/merchants only their own. Nobody confirms the other side.
    if (!sideMatches(body.side, t, who)) {
      throw httpErrors.createError(403, body.side === "paid" ? "Only the paying side can confirm they paid" : "Only the receiving side can confirm receipt");
    }
    const { status } = await touchTransferSide(ctx.prisma, t.id, body.side, req.user!.sub, body.note);
    await ctx.audit.record(actorFor(req), body.side === "paid" ? "money.confirm_paid" : "money.confirm_received", "money_transfer", t.id);
    return { ok: true, status };
  });

  // Either side disputes with a reason — freezes until resolved.
  app.post<{ Params: { id: string } }>("/api/money-transfers/:id/dispute", { preHandler: ctx.requireAuth }, async (req) => {
    const body = DisputeBody.parse(req.body);
    const t = await ctx.prisma.moneyTransfer.findUnique({ where: { id: req.params.id } });
    if (!t) throw httpErrors.createError(404, "Transfer not found");
    const who = await callerSides(ctx, req);
    if (!sideMatches("paid", t, who) && !sideMatches("received", t, who)) {
      throw httpErrors.createError(403, "Only a party to this transfer can dispute it");
    }
    if (t.status === "disputed") throw httpErrors.createError(409, "Already disputed");
    await ctx.prisma.moneyTransfer.update({ where: { id: t.id }, data: { status: "disputed", note: body.note } });
    await ctx.audit.record(actorFor(req), "money.dispute", "money_transfer", t.id, { note: body.note });
    return { ok: true, status: "disputed" as const };
  });
}

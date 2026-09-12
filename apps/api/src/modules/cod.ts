import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { minorOf } from "@ronmacrae/money";
import type { CodStatus, JobSummaryDto } from "@ronmacrae/contracts";
import { COD_STATUSES } from "@ronmacrae/contracts";
import { actorType, assertJobBusiness, codEventToDto, jobInclude, jobSummaryToDto, jobToDto, type Actor, type JobRow, type Viewer } from "./jobs/index.js";

const actorFor = (req: FastifyRequest): Actor => ({ id: req.user!.sub, name: req.user!.name, role: req.user!.role, riderId: req.user!.riderId, businessId: req.user!.businessId });
const viewerFor = (req: FastifyRequest): Viewer => ({ role: req.user!.role, riderId: req.user!.riderId, businessId: req.user!.businessId });

const HandInBody = z.object({
  /** major units — the cash actually being handed over right now */
  amountHandedIn: z.number().min(0).max(10_000_000),
  note: z.string().max(300).optional().or(z.literal("")).nullable().default(""),
});

const ApproveBody = z.object({
  note: z.string().max(300).optional().or(z.literal("")).nullable().default(""),
});

const DisputeBody = z.object({
  note: z.string().max(300).min(1, "A note explaining the dispute is required"),
});

const ListQuery = z.object({
  status: z.enum(COD_STATUSES).optional(),
  riderId: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

/** Only these roles may act on behalf of a rider for "late reconciliation" — mirrors recordCollection's existing precedent. Accountant/viewer never record on the rider's behalf; they approve/dispute what's already recorded. */
const RECORDING_STAFF = ["admin", "dispatcher"];

function assertCanRecord(actor: Actor, row: Pick<JobRow, "riderId">): void {
  if (actor.role === "rider") {
    if (row.riderId !== actor.riderId) throw httpErrors.createError(403, "You can only record COD for your own jobs");
    return;
  }
  if (!RECORDING_STAFF.includes(actor.role)) throw httpErrors.createError(403, "Insufficient permissions to record COD collection");
}

async function getRow(ctx: AppCtx, jobId: string, actorOrViewer: { role: string; businessId?: string | null }): Promise<JobRow> {
  const row = await ctx.prisma.job.findUnique({ where: { id: jobId }, include: jobInclude });
  if (!row) throw httpErrors.createError(404, "Job not found");
  assertJobBusiness(actorOrViewer, row.businessId);
  return row;
}

async function writeCodEvent(
  ctx: AppCtx,
  jobId: string,
  from: CodStatus | null,
  to: CodStatus,
  actor: Actor,
  note: string | null,
  meta: object = {},
): Promise<void> {
  await ctx.prisma.codEvent.create({
    data: { jobId, from, to, actorType: actorType(actor.role), actorId: actor.id, actorName: actor.name, note, meta },
  });
}

export async function codRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const monitor = ctx.requireStaff("admin", "dispatcher", "accountant", "viewer");
  // Dispatch is the one actually handed the cash day-to-day (spec item 8 —
  // "Dispatch must press Approve Cash Drop-Off"), so they approve alongside
  // accountant/admin. Disputing a mismatch stays an accountant/admin-only
  // escalation — a deliberate, separate judgment call, not day-to-day
  // reconciliation.
  const approver = ctx.requireStaff("admin", "dispatcher", "accountant");
  const disputer = ctx.requireStaff("admin", "accountant");

  // Dispatcher/owner/accountant board: every COD job, optionally filtered by
  // reconciliation status (e.g. "handed_in" = awaiting approval).
  app.get("/api/cod", { preHandler: monitor }, async (req) => {
    const q = ListQuery.parse(req.query);
    const where = {
      businessId: req.user!.businessId!,
      paymentMethod: "cod" as const,
      ...(q.status ? { codStatus: q.status } : {}),
      ...(q.riderId ? { riderId: q.riderId } : {}),
    };
    const [jobs, total] = await Promise.all([
      ctx.prisma.job.findMany({
        where,
        include: jobInclude,
        orderBy: { updatedAt: "desc" },
        take: q.take,
        skip: q.skip,
      }),
      ctx.prisma.job.count({ where }),
    ]);
    return { jobs: jobs.map((j): JobSummaryDto => jobSummaryToDto(j)), total };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/cod/events", { preHandler: ctx.requireAuth }, async (req) => {
    const row = await getRow(ctx, req.params.id, { role: req.user!.role, businessId: req.user!.businessId });
    if (req.user!.role === "rider" && row.riderId !== req.user!.riderId) {
      throw httpErrors.createError(403, "Not your job");
    }
    if (req.user!.role !== "rider" && !["admin", "dispatcher", "accountant", "viewer"].includes(req.user!.role)) {
      throw httpErrors.createError(403, "Insufficient permissions");
    }
    const events = await ctx.prisma.codEvent.findMany({ where: { jobId: req.params.id }, orderBy: { at: "asc" } });
    return { events: events.map(codEventToDto) };
  });

  // Rider (or staff, for late reconciliation) records cash handed in to the
  // office. Requires collection to have already been recorded first — you
  // can't hand in money nobody has recorded collecting.
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cod/hand-in", { preHandler: ctx.requireAuth }, async (req) => {
    const body = HandInBody.parse(req.body);
    const actor = actorFor(req);
    const row = await getRow(ctx, req.params.id, actor);
    assertCanRecord(actor, row);
    if (row.paymentMethod !== "cod") throw httpErrors.createError(409, "This job is not cash-on-delivery");
    if (row.codStatus === "approved") throw httpErrors.createError(409, "This entry is already approved and cannot be changed — ask an accountant to dispute it first if it needs correcting");
    if (row.codStatus === "pending_collection") throw httpErrors.createError(409, "Record the collection before recording a handover");

    const amountMinor = minorOf(body.amountHandedIn, row.currency);
    const from = row.codStatus as CodStatus;
    const updated = await ctx.prisma.$transaction(async (tx) => {
      const job = await tx.job.update({
        where: { id: req.params.id },
        include: jobInclude,
        data: { codHandedInAmount: amountMinor, codHandoverAt: new Date(), codStatus: "handed_in", codRiderNote: body.note || row.codRiderNote },
      });
      await tx.codEvent.create({
        data: {
          jobId: req.params.id,
          from,
          to: "handed_in",
          actorType: actorType(actor.role),
          actorId: actor.id,
          actorName: actor.name,
          note: body.note || null,
          meta: { amountHandedInMajor: body.amountHandedIn, currency: row.currency },
        },
      });
      return job;
    });
    await ctx.audit.record(actor, "cod.hand_in", "job", req.params.id, { amountHandedInMajor: body.amountHandedIn });
    return { job: jobToDto(updated, viewerFor(req), ctx.config.APP_ORIGIN) };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cod/approve", { preHandler: approver }, async (req) => {
    const body = ApproveBody.parse(req.body ?? {});
    const actor = actorFor(req);
    const row = await getRow(ctx, req.params.id, actor);
    if (row.paymentMethod !== "cod") throw httpErrors.createError(409, "This job is not cash-on-delivery");
    if (row.codStatus === "approved") throw httpErrors.createError(409, "Already approved");
    if (row.codStatus === "pending_collection") throw httpErrors.createError(409, "Nothing has been collected yet");

    const from = row.codStatus as CodStatus;
    const updated = await ctx.prisma.$transaction(async (tx) => {
      const job = await tx.job.update({
        where: { id: req.params.id },
        include: jobInclude,
        data: {
          codStatus: "approved",
          codApprovedById: actor.id,
          codApprovedAt: new Date(),
          codAccountantNote: body.note || row.codAccountantNote,
        },
      });
      await tx.codEvent.create({
        data: { jobId: req.params.id, from, to: "approved", actorType: actorType(actor.role), actorId: actor.id, actorName: actor.name, note: body.note || null },
      });
      return job;
    });
    await ctx.audit.record(actor, "cod.approve", "job", req.params.id, { note: body.note || null });
    return { job: jobToDto(updated, viewerFor(req), ctx.config.APP_ORIGIN) };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cod/dispute", { preHandler: disputer }, async (req) => {
    const body = DisputeBody.parse(req.body);
    const actor = actorFor(req);
    const row = await getRow(ctx, req.params.id, actor);
    if (row.paymentMethod !== "cod") throw httpErrors.createError(409, "This job is not cash-on-delivery");
    if (row.codStatus === "pending_collection") throw httpErrors.createError(409, "Nothing has been collected yet");

    const from = row.codStatus as CodStatus;
    const updated = await ctx.prisma.$transaction(async (tx) => {
      const job = await tx.job.update({
        where: { id: req.params.id },
        include: jobInclude,
        data: { codStatus: "disputed", codAccountantNote: body.note },
      });
      await tx.codEvent.create({
        data: { jobId: req.params.id, from, to: "disputed", actorType: actorType(actor.role), actorId: actor.id, actorName: actor.name, note: body.note },
      });
      return job;
    });
    await ctx.audit.record(actor, "cod.dispute", "job", req.params.id, { note: body.note });
    return { job: jobToDto(updated, viewerFor(req), ctx.config.APP_ORIGIN) };
  });
}

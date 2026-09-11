import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../../ctx.js";
import type { JobSummaryDto, TrashedJobDto } from "@ronmacrae/contracts";
import { ACTIVE_JOB_STATUSES } from "@ronmacrae/contracts";
import { assertJobBusiness, jobSummaryToDto, type Actor } from "./dto.js";
import { getJobRowAnyDeletionState, listJobs } from "./repository.js";

/**
 * Deleted-orders trash (Stage 26, spec 8) — soft-delete only, ever. See
 * schema.prisma's own note on Job.deletedAt for why: every ledger/dispute/
 * audit row referencing a job cascades on a real delete, so a real delete
 * would take the financial and audit trail with it. This never issues one.
 *
 * 30-day restore window, computed from `deletedAt` rather than a separate
 * stored "purged" flag — always correct regardless of whether any
 * scheduled job has run, immune to a missed cron tick. `scripts/
 * purge-deleted-jobs.mjs` is the "scheduled purge" the spec asks for: it
 * doesn't delete anything (there is nothing to delete) — it just records
 * an audit entry the first time each job crosses the 30-day mark, a real,
 * runnable, idempotent compliance record of "restore is no longer
 * offered for this one," safe to run from any real scheduler (cron,
 * launchd, a hosting platform's scheduled-job feature) or not at all —
 * the restore-window enforcement below works identically either way.
 */
export const PURGE_DAYS = 30;

export function purgeEligibleAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + PURGE_DAYS * 24 * 3600_000);
}

export function isPurged(deletedAt: Date, now: Date = new Date()): boolean {
  return now >= purgeEligibleAt(deletedAt);
}

/** A job actively out with a rider (or otherwise unresolved-with-rider) is
 *  never eligible for trash — cancel it or let it resolve first. Anything
 *  else (new, failed, delivered, cancelled, returned) can be trashed. */
function assertDeletable(status: string): void {
  if (ACTIVE_JOB_STATUSES.includes(status as (typeof ACTIVE_JOB_STATUSES)[number])) {
    throw httpErrors.createError(409, `This delivery is still active (${status}) — cancel or complete it before deleting.`);
  }
}

/** Cash still genuinely at stake (collected but not yet reconciled, or
 *  under active dispute) must be resolved before the order can be
 *  trashed — deleting it must never look like a way to make an
 *  outstanding COD discrepancy disappear from the ordinary working view. */
const COD_BLOCKS_DELETE = new Set(["collected", "handed_in", "disputed"]);
function assertNoOutstandingCod(codStatus: string): void {
  if (COD_BLOCKS_DELETE.has(codStatus)) {
    throw httpErrors.createError(409, `This delivery has unresolved cash-on-delivery (${codStatus}) — resolve it in COD reconciliation before deleting.`);
  }
}

function actorFor(req: FastifyRequest): Actor {
  return {
    id: req.user?.sub ?? null,
    name: req.user?.name ?? null,
    role: req.user?.role ?? "anonymous",
    riderId: req.user?.riderId ?? null,
    businessId: req.user?.businessId ?? null,
  };
}

export async function deleteJob(ctx: AppCtx, jobId: string, actor: Actor, reason?: string | null): Promise<void> {
  const job = await getJobRowAnyDeletionState(ctx, jobId);
  if (!job) throw httpErrors.createError(404, "Job not found");
  assertJobBusiness(actor, job.businessId);
  if (job.deletedAt) throw httpErrors.createError(409, "This delivery is already in the trash");
  assertDeletable(job.status);
  assertNoOutstandingCod(job.codStatus);

  await ctx.prisma.job.update({
    where: { id: jobId },
    data: { deletedAt: new Date(), deletedById: actor.id, deleteReason: reason || null },
  });
  await ctx.audit.record(actor, "job.delete", "job", jobId, { reason: reason || null, statusAtDeletion: job.status });
}

export async function restoreJob(ctx: AppCtx, jobId: string, actor: Actor): Promise<JobSummaryDto> {
  const job = await getJobRowAnyDeletionState(ctx, jobId);
  if (!job) throw httpErrors.createError(404, "Job not found");
  assertJobBusiness(actor, job.businessId);
  if (!job.deletedAt) throw httpErrors.createError(409, "This delivery isn't in the trash");
  if (isPurged(job.deletedAt)) {
    throw httpErrors.createError(410, `The ${PURGE_DAYS}-day restore window for this delivery has passed.`);
  }

  const restored = await ctx.prisma.job.update({
    where: { id: jobId },
    data: { deletedAt: null, deletedById: null, deleteReason: null },
    include: { customer: true, zone: true, rider: true },
  });
  await ctx.audit.record(actor, "job.restore", "job", jobId, {});
  return jobSummaryToDto(restored as never);
}

async function listTrash(ctx: AppCtx, businessId: string): Promise<TrashedJobDto[]> {
  const rows = await listJobs(ctx, { businessId, deleted: true, take: 200, sort: "newest" });
  if (rows.length === 0) return [];
  const deleterIds = [...new Set(rows.map((r) => r.deletedById).filter((id): id is string => Boolean(id)))];
  const deleters = deleterIds.length ? await ctx.prisma.user.findMany({ where: { id: { in: deleterIds } }, select: { id: true, name: true } }) : [];
  const nameById = new Map(deleters.map((u) => [u.id, u.name]));
  const now = new Date();
  return rows.map((r) => {
    const deletedAt = r.deletedAt!;
    const purged = isPurged(deletedAt, now);
    const daysRemaining = Math.max(0, Math.ceil((purgeEligibleAt(deletedAt).getTime() - now.getTime()) / 86_400_000));
    return {
      ...jobSummaryToDto(r),
      deletedAt: deletedAt.toISOString(),
      deletedByName: r.deletedById ? (nameById.get(r.deletedById) ?? null) : null,
      deleteReason: r.deleteReason,
      purged,
      daysRemaining,
    };
  });
}

const DeleteBody = z.object({ reason: z.string().max(300).optional().or(z.literal("")).nullable() });

export async function trashRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const staff = ctx.requireStaff("admin", "dispatcher", "accountant", "viewer");
  const writer = ctx.requireStaff("admin", "dispatcher");

  app.get("/api/jobs/trash", { preHandler: staff }, async (req) => {
    return { jobs: await listTrash(ctx, req.user!.businessId!) };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/delete", { preHandler: writer }, async (req) => {
    const body = DeleteBody.parse(req.body ?? {});
    await deleteJob(ctx, req.params.id, actorFor(req), body.reason);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/restore", { preHandler: writer }, async (req) => {
    const job = await restoreJob(ctx, req.params.id, actorFor(req));
    return { job };
  });
}

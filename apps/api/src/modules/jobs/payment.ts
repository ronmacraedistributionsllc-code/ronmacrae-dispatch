import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../../ctx.js";
import { majorOf, minorOf, money } from "@ronmacrae/money";
import type { JobDto, JobStatus, PaymentStatus } from "@ronmacrae/contracts";
import { actorType, jobInclude, jobToDto, type Actor, type JobRow, type Viewer } from "./dto.js";
import { getJobRow } from "./repository.js";

/** Statuses where a rider can (re)record collected cash. */
const COLLECTABLE_STATUSES: JobStatus[] = [
  "accepted",
  "picked_up",
  "in_transit",
  "delivering",
  "delivered",
  "no_answer",
  "location_changed",
  "failed",
];

/**
 * Cash position derivation:
 *  - prepaid (card/transfer) jobs are always `paid` (the rider collects nothing)
 *  - COD: paid when collected >= expected, partial when some, else unpaid.
 *    A null expected amount (free delivery) is vacuously paid.
 */
export function derivePaymentStatus(
  expected: number | null,
  collected: number | null,
  method: string,
): PaymentStatus {
  if (method !== "cod") return "paid";
  if (expected == null || expected <= 0) return "paid";
  const c = collected ?? 0;
  if (c >= expected) return "paid";
  if (c > 0) return "partial";
  return "unpaid";
}

/** Resolve the cash fields after a collection report (or a default on delivery). */
export function resolveCollection(
  job: Pick<JobRow, "currency" | "paymentMethod" | "amountExpected" | "amountCollected">,
  reportedMajor: number | null,
): { amountCollected: number; paymentStatus: PaymentStatus } {
  const cur = job.currency;
  const collected = reportedMajor != null ? minorOf(reportedMajor, cur) : job.amountCollected ?? 0;
  return {
    amountCollected: collected,
    paymentStatus: derivePaymentStatus(job.amountExpected, collected, job.paymentMethod),
  };
}

export interface CollectInput {
  /** major units collected (replaces the previous total) */
  amountCollected?: number;
  note?: string | null;
}

export const CollectBody = z.object({
  amountCollected: z.number().min(0).max(10_000_000).optional(),
  note: z.string().max(300).optional().or(z.literal("")).nullable().default(""),
});

/**
 * Record/adjust the cash collected for a job. Callable by the assigned rider
 * (bearer) and by staff (late reconciliation). Writes a same-status event.
 */
export async function recordCollection(
  ctx: AppCtx,
  jobId: string,
  input: CollectInput,
  actor: Actor,
  viewer: Viewer,
): Promise<JobDto> {
  const row = await getJobRow(ctx, jobId);
  if (!row) throw httpErrors.createError(404, "Job not found");
  if (!COLLECTABLE_STATUSES.includes(row.status)) {
    throw httpErrors.createError(409, `Cannot record a collection while the job is ${row.status}`);
  }
  if (actor.role === "rider" && row.riderId !== actor.riderId) {
    throw httpErrors.createError(403, "You can only record collections for your own jobs");
  }

  const reported = input.amountCollected ?? null;
  const cash = resolveCollection(row, reported);
  const reportedMajor =
    reported != null ? reported : majorOf(money(row.amountCollected ?? 0, row.currency));

  const updated = await ctx.prisma.$transaction(async (tx) => {
    const job = await tx.job.update({
      where: { id: jobId },
      include: jobInclude,
      data: {
        amountCollected: cash.amountCollected,
        paymentStatus: cash.paymentStatus,
      },
    });
    await tx.jobEvent.create({
      data: {
        jobId,
        from: job.status,
        to: job.status,
        actorType: actorType(actor.role),
        actorId: actor.id,
        actorName: actor.name,
        note: input.note ?? null,
        meta: { amountCollectedMajor: reportedMajor, currency: row.currency } as object,
      },
    });
    return job;
  });

  return jobToDto(updated, viewer, ctx.config.APP_ORIGIN);
}

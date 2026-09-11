import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import { Prisma } from "@prisma/client";
import type { AppCtx } from "../../ctx.js";
import { haversineM } from "@ronmacrae/geo";
import { majorOf, money } from "@ronmacrae/money";
import type {
  FailureReason,
  GeoPoint,
  JobDto,
  JobStatus,
  RiderStage,
} from "@ronmacrae/contracts";
import {
  CUSTOMER_BROADCAST_STATUSES,
  FAILURE_REASONS,
  JOB_STATUSES,
  RIDER_STAGES,
  RETURNABLE_STATUSES,
  TERMINAL_JOB_STATUSES,
  TRANSITION_PRIMARY_ACTOR,
  allowedTransitions,
  canTransition,
  roomForCustomer,
  roomForDispatch,
  roomForJob,
  roomForRider,
} from "@ronmacrae/contracts";
import { pointFromJson, pointToJson } from "../../geo-mappers.js";
import { deliveryPin } from "../../lib/ids.js";
import { getBusinessSettings } from "../settings.js";
import { JobNotifier } from "../notify.js";
import {
  actorType,
  assertJobBusiness,
  eventToDto,
  jobInclude,
  jobToDto,
  type Actor,
  type JobRow,
  type Viewer,
} from "./dto.js";
import { getJobRow, latestRiderPoint, nextJobNumber } from "./repository.js";
import { resolveCollection } from "./payment.js";

/** Assumed preview speed for ETA/simulation legs (m/s). */
const LEG_SPEED_MPS = 8;

export const TransitionBody = z.object({
  to: z.enum(JOB_STATUSES),
  note: z.string().max(300).optional().or(z.literal("")).nullable().default(""),
  failureReason: z.enum(FAILURE_REASONS).optional().nullable(),
  failureNote: z.string().max(300).optional().or(z.literal("")).nullable().default(""),
  point: z
    .object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) })
    .optional()
    .nullable(),
  addressText: z.string().max(200).optional().or(z.literal("")).nullable(),
  landmark: z.string().max(120).optional().or(z.literal("")).nullable(),
  stage: z.enum(RIDER_STAGES).optional(),
  amountCollected: z.number().min(0).max(10_000_000).optional(),
});

export interface TransitionInput {
  to: JobStatus;
  note?: string | null;
  failureReason?: FailureReason | null;
  failureNote?: string | null;
  point?: GeoPoint | null;
  addressText?: string | null;
  landmark?: string | null;
  stage?: RiderStage;
  /** major units; defaults to the full expected amount on delivery */
  amountCollected?: number;
}

/**
 * Record a rider's progress within the current job status. Stages are
 * deliberately events rather than status transitions (for example, a rider
 * can arrive at pickup while the job remains accepted).
 */
export async function recordRiderStage(
  ctx: AppCtx,
  jobId: string,
  stage: RiderStage,
  input: Pick<TransitionInput, "note">,
  actor: Actor,
  viewer: Viewer,
): Promise<JobDto> {
  const row = await getJobRow(ctx, jobId);
  if (!row) throw httpErrors.createError(404, "Job not found");
  if (actor.role === "rider" && row.riderId !== actor.riderId) throw httpErrors.createError(403, "Not your job");
  assertJobBusiness(actor, row.businessId);
  if (TERMINAL_JOB_STATUSES.includes(row.status)) throw httpErrors.createError(409, "Cannot update a closed job");
  // Duplicate-submit guard: a repeated tap of the same stage (double-click,
  // retried offline action) is a harmless no-op rather than a second audit
  // event and a second customer notification for the same progress update.
  if (row.stage === stage) return jobToDto(row, viewer, ctx.config.APP_ORIGIN);

  const updated = await ctx.prisma.$transaction(async (tx) => {
    // Same optimistic guard as transitionJob: only apply if the job's stage
    // hasn't already moved on since we read `row` above.
    const guarded = await tx.job.updateMany({ where: { id: jobId, stage: row.stage }, data: { stage } });
    if (guarded.count === 0) {
      throw httpErrors.createError(409, "This job's progress already moved on — refresh and try again");
    }
    const job = await tx.job.findUniqueOrThrow({ where: { id: jobId }, include: jobInclude });
    const event = await tx.jobEvent.create({
      data: {
        jobId,
        from: row.status,
        to: row.status,
        actorType: actorType(actor.role),
        actorId: actor.id,
        actorName: actor.name,
        note: input.note || null,
        meta: { stage } as object,
      },
    });
    return { job, event };
  });
  const dto = jobToDto(updated.job, viewer, ctx.config.APP_ORIGIN);
  ctx.hub.broadcastMany([roomForDispatch(row.businessId), roomForJob(jobId)], {
    type: "job.state",
    payload: { job: dto, event: eventToDto(updated.event) },
  });
  if (row.customer.consentTracking) {
    const business = await getBusinessSettings(ctx, row.businessId);
    const linkUrl = updated.job.link ? `${ctx.config.APP_ORIGIN}/track/${updated.job.link.token}` : null;
    await new JobNotifier(ctx.notify)
      .forRiderStage(stage, {
        job: {
          id: jobId,
          externalRef: updated.job.externalRef,
          customerName: updated.job.customer.name,
          customerPhone: updated.job.customer.phone,
          failureReason: null,
          routeEta: dto.routeEta,
          completedAt: dto.completedAt,
        },
        linkUrl,
        riderName: updated.job.rider?.name ?? null,
        business: business.businessName,
        dispatchPhone: business.dispatchPhone,
      })
      .catch((err) => ctx.log.error({ err: String(err), jobId }, "stage notification failed"));
  }
  return dto;
}

function stageFor(to: JobStatus, current: RiderStage, requested: RiderStage | undefined): RiderStage {
  if (requested && !TERMINAL_JOB_STATUSES.includes(to)) return requested;
  switch (to) {
    case "accepted":
      return "heading_to_pickup";
    case "picked_up":
    case "in_transit":
    case "delivering":
      return "heading_to_dropoff";
    case "new":
      return "none";
    default:
      return TERMINAL_JOB_STATUSES.includes(to) ? "none" : current;
  }
}

/** Duration of a straight leg between two points, at the preview speed. */
function legDurationS(from: GeoPoint | null, to: GeoPoint | null): number {
  if (!from || !to) return 120;
  return Math.max(45, Math.round(haversineM(from, to) / LEG_SPEED_MPS));
}

/**
 * Apply a job status transition with all its side effects:
 * state-machine guard, per-role guard, stage, cash, ETA, rider status,
 * realtime broadcast, customer notification and the location simulation.
 */
export async function transitionJob(
  ctx: AppCtx,
  jobId: string,
  input: TransitionInput,
  actor: Actor,
  viewer: Viewer,
): Promise<JobDto> {
  const row = await getJobRow(ctx, jobId);
  if (!row) throw httpErrors.createError(404, "Job not found");
  const from = row.status;
  const to = input.to;
  if (!canTransition(from, to)) {
    throw httpErrors.createError(
      409,
      `Invalid transition ${from} -> ${to} (allowed: ${allowedTransitions(from).join(", ") || "none"})`,
    );
  }
  if (actor.role === "rider") {
    if (row.riderId !== actor.riderId) throw httpErrors.createError(403, "Not your job");
    if (TRANSITION_PRIMARY_ACTOR[to] !== "rider") {
      throw httpErrors.createError(403, `Riders cannot move a job to ${to}`);
    }
  } else {
    assertJobBusiness(actor, row.businessId);
  }

  const terminal = TERMINAL_JOB_STATUSES.includes(to);
  const point =
    to === "location_changed" && input.point
      ? (pointToJson(input.point) ?? Prisma.JsonNull)
      : undefined;
  // On delivery an unreported collection defaults to the full expected amount
  // (a delivered COD job is presumed paid); the bearer/staff can report the
  // actual figure via `amountCollected`.
  const cashDefault = input.amountCollected ?? majorOf(money(row.amountExpected ?? 0, row.currency));
  const cash = to === "delivered" ? resolveCollection(row, cashDefault) : undefined;
  const eta =
    to === "in_transit" || to === "delivering"
      ? new Date(Date.now() + legDurationS(await latestRiderPoint(ctx, row.riderId ?? ""), row.point ? pointFromJson(row.point) : null) * 1000)
      : undefined;

  const updated = await ctx.prisma.$transaction(async (tx) => {
    // Guard against a double-submit/race (two requests for the same job
    // arriving concurrently, e.g. a double-tap before the button disables):
    // the WHERE clause only matches if the job is STILL in `from` at write
    // time. updateMany (rather than update-by-id) lets us filter on the
    // non-unique `status` column; a count of 0 means someone else already
    // moved this job, so this request must not silently double-apply cash,
    // notifications, or a second JobEvent on top of it.
    const guarded = await tx.job.updateMany({
      where: { id: jobId, status: from },
      data: {
        status: to,
        stage: stageFor(to, row.stage, input.stage),
        ...(to === "failed" ? { failureReason: input.failureReason ?? "other", failureNote: input.failureNote || null } : {}),
        ...(to === "no_answer" ? { failureReason: "no_answer", failureNote: input.failureNote || null } : {}),
        ...(terminal ? { completedAt: new Date() } : {}),
        ...(to === "location_changed"
          ? {
              point,
              ...(input.addressText !== undefined ? { addressText: input.addressText || row.addressText } : {}),
              ...(input.landmark !== undefined ? { landmark: input.landmark || row.landmark } : {}),
            }
          : {}),
        ...(cash ? { amountCollected: cash.amountCollected, paymentStatus: cash.paymentStatus } : {}),
        ...(eta ? { routeEta: eta } : {}),
      },
    });
    if (guarded.count === 0) {
      throw httpErrors.createError(409, `This job already moved on from '${from}' — refresh and try again`);
    }
    const job = await tx.job.findUniqueOrThrow({ where: { id: jobId }, include: jobInclude });
    const event = await tx.jobEvent.create({
      data: {
        jobId,
        from,
        to,
        actorType: actorType(actor.role),
        actorId: actor.id,
        actorName: actor.name,
        note: input.note || null,
        meta: {
          ...(input.failureReason ? { failureReason: input.failureReason } : {}),
          ...(input.amountCollected != null ? { amountCollected: input.amountCollected } : {}),
          ...(input.stage ? { stage: input.stage } : {}),
        } as object,
      },
    });
    // Rider status ("Available for jobs" / "Unavailable") is rider-controlled
    // (see RidersService.setStatus) and is deliberately NOT touched by job
    // lifecycle transitions here — accepting a job must not silently flip a
    // rider out of "available" (that was the old behavior and is exactly the
    // bug this comment replaces: it made a rider invisible to further offer
    // broadcasts the moment they accepted their first job, even while well
    // under capacity for more). A rider's active-job count is derived directly
    // from their jobs, not tracked via a status enum.
    return { job, event };
  });
  const { job, event } = updated;
  const eventDto = eventToDto(event);
  const dto = jobToDto(job, viewer, ctx.config.APP_ORIGIN);

  // realtime: dispatch + job room + customer room for customer-visible statuses
  const dispatchRoom = roomForDispatch(row.businessId);
  const rooms = [dispatchRoom, roomForJob(jobId)];
  if (CUSTOMER_BROADCAST_STATUSES.includes(to)) rooms.push(roomForCustomer(job.customerId));
  ctx.hub.broadcastMany(rooms, { type: "job.state", payload: { job: dto, event: eventDto } });
  if (row.riderId && (to === "assigned" || to === "accepted")) {
    ctx.hub.broadcastMany([roomForRider(row.riderId), dispatchRoom], {
      type: "job.assigned",
      payload: { job: dto, riderId: row.riderId },
    });
  }

  // location simulation legs
  const sim = ctx.sim;
  if (row.riderId && (job.point != null || job.pickupPoint != null)) {
    const dropoff = job.point ? pointFromJson(job.point) : null;
    const pickup = job.pickupPoint ? pointFromJson(job.pickupPoint) : null;
    const riderNow = await latestRiderPoint(ctx, row.riderId);
    if (to === "accepted" && pickup) {
      const from = riderNow ?? (row.rider?.basePoint ? pointFromJson(row.rider.basePoint) : null);
      if (from) sim.startForJob({ jobId, riderId: row.riderId, from, to: pickup, durationS: legDurationS(from, pickup) });
    } else if ((to === "picked_up" || to === "in_transit" || to === "delivering" || to === "location_changed") && dropoff) {
      const from = riderNow ?? pickup;
      if (from) sim.startForJob({ jobId, riderId: row.riderId, from, to: dropoff, durationS: legDurationS(from, dropoff) });
    } else {
      void sim.reconcileJob(jobId, to, job.riderId);
    }
  } else {
    void sim.reconcileJob(jobId, to, job.riderId);
  }

  // customer notification (only when the customer consented to tracking)
  if (row.customer.consentTracking) {
    const business = await getBusinessSettings(ctx, row.businessId);
    const linkUrl = job.link ? `${ctx.config.APP_ORIGIN}/track/${job.link.token}` : null;
    const notifier = new JobNotifier(ctx.notify);
    await notifier
      .forJobEvent(eventDto, {
        job: {
          id: jobId,
          externalRef: job.externalRef,
          customerName: job.customer.name,
          customerPhone: job.customer.phone,
          failureReason: to === "failed" ? input.failureReason ?? "other" : null,
          routeEta: dto.routeEta,
          completedAt: dto.completedAt,
        },
        linkUrl,
        riderName: job.rider?.name ?? null,
        business: business.businessName,
        dispatchPhone: business.dispatchPhone,
      })
      .catch((err) => ctx.log.error({ err: String(err), jobId }, "job notification failed"));
  }

  return dto;
}

/** Staff cancellation with an optional reason note. */
export async function cancelJob(
  ctx: AppCtx,
  jobId: string,
  actor: Actor,
  viewer: Viewer,
  note?: string | null,
): Promise<JobDto> {
  return transitionJob(ctx, jobId, { to: "cancelled", note }, actor, viewer);
}

/**
 * Create a linked `return` job (package travelling back to the store) from a
 * delivered or failed job. The original job keeps its status.
 */
export async function createReturnJob(
  ctx: AppCtx,
  originalJobId: string,
  actor: Actor,
  viewer: Viewer,
): Promise<JobDto> {
  const original = await getJobRow(ctx, originalJobId);
  if (!original) throw httpErrors.createError(404, "Job not found");
  assertJobBusiness(actor, original.businessId);
  if (!RETURNABLE_STATUSES.includes(original.status)) {
    throw httpErrors.createError(409, `Only delivered or failed jobs can be returned (job is ${original.status})`);
  }
  const cur = ctx.config.OPERATIONAL_CURRENCY;
  const row = await ctx.prisma.$transaction(async (tx) => {
    const job = await tx.job.create({
      data: {
        businessId: original.businessId,
        jobNumber: await nextJobNumber(ctx, original.businessId),
        externalRef: null,
        source: "manual",
        originalJobId,
        customerId: original.customerId,
        type: "return",
        status: "new",
        priority: original.priority,
        addressText: `Store - return of ${original.jobNumber ?? original.id}`,
        landmark: null,
        point: Prisma.JsonNull,
        pickupPoint: Prisma.JsonNull,
        itemSummary: `Return of ${original.jobNumber ?? original.id}`,
        currency: cur,
        paymentMethod: "cod",
        paymentStatus: "paid",
        pin: deliveryPin(ctx.config.PIN_LENGTH),
        amountExpected: 0,
        amountCollected: 0,
      },
      include: jobInclude,
    });
    await tx.jobEvent.create({
      data: {
        jobId: job.id,
        from: null,
        to: "new",
        actorType: actorType(actor.role),
        actorId: actor.id,
        actorName: actor.name,
        note: `return of ${original.jobNumber ?? original.id}`,
        meta: { originalJobId } as object,
      },
    });
    return job;
  });
  return jobToDto(row, viewer, ctx.config.APP_ORIGIN, { returnJobId: null });
}

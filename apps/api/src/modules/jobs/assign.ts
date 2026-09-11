import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../../ctx.js";
import type { JobDto, JobStatus } from "@ronmacrae/contracts";
import { ACTIVE_JOB_STATUSES, roomForDispatch, roomForJob, roomForRider } from "@ronmacrae/contracts";
import { haversineM } from "@ronmacrae/geo";
import { pointFromJson } from "../../geo-mappers.js";
import { getBusinessSettings } from "../settings.js";
import { JobNotifier } from "../notify.js";
import { actorType, assertJobBusiness, eventToDto, jobInclude, jobToDto, type Actor, type Viewer } from "./dto.js";
import { getJobRow, latestRiderPoint } from "./repository.js";

export const AssignBody = z.object({
  riderId: z.string().min(1),
  reason: z.string().max(200).optional().or(z.literal("")).nullable().default(""),
});

export interface AssignInput {
  riderId: string;
  reason?: string | null;
}

/**
 * Assign (or reassign) a job to a rider.
 *  - `new` job      -> status becomes `assigned`
 *  - `assigned` job -> status stays; the old assignment row is marked
 *    `reassigned` and a new row records the new rider
 * Riders may not be at capacity; only new/assigned jobs can be assigned.
 */
export async function assignJob(
  ctx: AppCtx,
  jobId: string,
  input: AssignInput,
  actor: Actor,
  viewer: Viewer,
): Promise<JobDto> {
  const row = await getJobRow(ctx, jobId);
  if (!row) throw httpErrors.createError(404, "Job not found");
  assertJobBusiness(actor, row.businessId);
  const rider = await ctx.prisma.rider.findUnique({ where: { id: input.riderId } });
  if (!rider) throw httpErrors.createError(404, "Rider not found");
  if (!rider.active) throw httpErrors.createError(409, `${rider.name} is not active`);
  // A dispatcher can only assign to a rider actually in their own network —
  // not to some other business's rider, even one they happen to share via a
  // separate membership elsewhere.
  const membership = await ctx.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId: input.riderId, businessId: row.businessId } } });
  if (membership?.status !== "active") throw httpErrors.createError(404, "Rider not found");
  if (row.status !== "new" && row.status !== "assigned") {
    throw httpErrors.createError(409, `Only new or unaccepted jobs can be assigned (job is ${row.status})`);
  }

  const oldRiderId = row.riderId;
  const reassign = row.status === "assigned" && oldRiderId != null && oldRiderId !== input.riderId;
  const activeCount = await ctx.prisma.job.count({
    where: { riderId: input.riderId, status: { in: [...ACTIVE_JOB_STATUSES] } },
  });
  const takesNewSlot = oldRiderId !== input.riderId && ACTIVE_JOB_STATUSES.includes(row.status);
  if (activeCount + (takesNewSlot ? 1 : 0) > rider.dailyCapacity) {
    throw httpErrors.createError(409, `${rider.name} is at capacity (${activeCount}/${rider.dailyCapacity} active jobs)`);
  }

  const from = row.status as JobStatus;
  const to: JobStatus = row.status === "new" ? "assigned" : row.status;
  const updated = await ctx.prisma.$transaction(async (tx) => {
    const claimed = await tx.job.updateMany({
      where: { id: jobId, status: from, riderId: oldRiderId },
      data: { riderId: input.riderId, status: to, stage: "heading_to_pickup" },
    });
    if (!claimed.count) {
      throw httpErrors.createError(409, `Job state changed — please refresh and try again (was ${from})`);
    }
    await tx.jobOffer.updateMany({
      where: { jobId, status: "open" },
      data: { status: "withdrawn", note: "assigned" },
    });
    const freshRider = await tx.rider.findUnique({ where: { id: input.riderId } });
    if (!freshRider?.active) {
      throw httpErrors.createError(409, `${rider.name} is not active`);
    }
    const postClaimActive = await tx.job.count({
      where: { riderId: input.riderId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    });
    if (postClaimActive > freshRider.dailyCapacity) {
      throw httpErrors.createError(409, `${rider.name} is at capacity (${postClaimActive}/${freshRider.dailyCapacity} active jobs)`);
    }
    if (reassign && oldRiderId) {
      await tx.riderAssignment.updateMany({
        where: { jobId, riderId: oldRiderId, status: { in: ["assigned", "accepted"] } },
        data: { status: "reassigned", reason: input.reason || null },
      });
    }
    await tx.riderAssignment.create({
      data: {
        jobId,
        riderId: input.riderId,
        status: "assigned",
        reason: input.reason || null,
        oldRiderId: reassign ? oldRiderId : null,
      },
    });
    const job = await tx.job.findUniqueOrThrow({ where: { id: jobId }, include: jobInclude });
    const event = await tx.jobEvent.create({
      data: {
        jobId,
        from,
        to,
        actorType: actorType(actor.role),
        actorId: actor.id,
        actorName: actor.name,
        note: input.reason || (reassign ? "reassigned" : null),
        meta: { riderId: input.riderId, oldRiderId: reassign ? oldRiderId : null } as object,
      },
    });
    return { job, event };
  });

  const dto = jobToDto(updated.job, viewer, ctx.config.APP_ORIGIN);
  const eventDto = eventToDto(updated.event);
  const dispatchRoom = roomForDispatch(row.businessId);

  // The old rider's socket, if still connected, must stop receiving this
  // job's live updates/messages the moment it's no longer theirs — see
  // hub.ts's leaveJobRoom for the gap this closes.
  if (reassign && oldRiderId) ctx.hub.leaveJobRoom(oldRiderId, jobId);

  ctx.hub.broadcastMany([roomForRider(input.riderId), dispatchRoom], {
    type: "job.assigned",
    payload: { job: dto, riderId: input.riderId, source: "assign" },
  });
  ctx.hub.broadcastMany([roomForJob(jobId), dispatchRoom], { type: "job.state", payload: { job: dto, event: eventDto } });

  // Direct assignment alerts only the one rider it was assigned to (not a broadcast
  // to every eligible rider — that's the offer flow). Content excludes customer
  // phone/name and the delivery PIN, same privacy bar as the offer-broadcast push.
  void ctx.push
    .sendToRider(input.riderId, {
      title: "New delivery assigned",
      body: [dto.pickupAddressText, dto.zoneName ?? dto.addressText].filter(Boolean).join(" → ") || "Open the app to view details",
      tag: `assign-${jobId}`,
      url: "/",
    })
    .catch((err) => ctx.log.error({ err: String(err), jobId }, "assignment push notification failed"));

  // simulated leg towards the pickup
  const pickup = row.pickupPoint ? pointFromJson(row.pickupPoint) : null;
  if (pickup) {
    const fromPoint =
      (await latestRiderPoint(ctx, input.riderId)) ??
      (rider.basePoint ? pointFromJson(rider.basePoint) : null);
    if (fromPoint) {
      ctx.sim.startForJob({
        jobId,
        riderId: input.riderId,
        from: fromPoint,
        to: pickup,
        durationS: Math.max(45, Math.round(haversineM(fromPoint, pickup) / 8)),
      });
    }
  }

  if (row.customer.consentTracking) {
    const business = await getBusinessSettings(ctx, row.businessId);
    const linkUrl = updated.job.link ? `${ctx.config.APP_ORIGIN}/track/${updated.job.link.token}` : null;
    await new JobNotifier(ctx.notify)
      .forJobEvent(eventDto, {
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
        riderName: rider.name,
        business: business.businessName,
        dispatchPhone: business.dispatchPhone,
      })
      .catch((err) => ctx.log.error({ err: String(err), jobId }, "assignment notification failed"));
  }

  return dto;
}

/** Take a job off a rider (back to `new`). Staff action or the rider's decline. */
export async function unassignJob(
  ctx: AppCtx,
  jobId: string,
  actor: Actor,
  viewer: Viewer,
  reason?: string | null,
  declined = false,
): Promise<JobDto> {
  const row = await getJobRow(ctx, jobId);
  if (!row) throw httpErrors.createError(404, "Job not found");
  if (actor.role === "rider" && row.riderId !== actor.riderId) {
    throw httpErrors.createError(403, "Not your job");
  }
  assertJobBusiness(actor, row.businessId);
  if (row.status !== "assigned" && row.status !== "accepted") {
    throw httpErrors.createError(409, `Only assigned jobs can be unassigned (job is ${row.status})`);
  }
  const riderId = row.riderId;

  const updated = await ctx.prisma.$transaction(async (tx) => {
    if (riderId) {
      await tx.riderAssignment.updateMany({
        where: { jobId, riderId, status: { in: ["assigned", "accepted"] } },
        data: { status: declined ? "declined" : "reassigned", reason: reason ?? null },
      });
    }
    const job = await tx.job.update({
      where: { id: jobId },
      data: { riderId: null, status: "new", stage: "none", routeEta: null },
      include: jobInclude,
    });
    const event = await tx.jobEvent.create({
      data: {
        jobId,
        from: row.status as JobStatus,
        to: "new",
        actorType: actorType(actor.role),
        actorId: actor.id,
        actorName: actor.name,
        note: reason ?? (declined ? "declined by rider" : null),
        meta: { declined } as object,
      },
    });
    // Rider status is rider-controlled (RidersService.setStatus) and is not
    // touched here — losing/declining one job must not silently override a
    // rider's own "unavailable" choice, or their availability while other jobs
    // are still active.
    return { job, event };
  });
  const dto = jobToDto(updated.job, viewer, ctx.config.APP_ORIGIN);
  void ctx.sim.reconcileJob(jobId, "new", null);
  if (riderId) ctx.hub.leaveJobRoom(riderId, jobId);
  ctx.hub.broadcastMany([roomForJob(jobId), roomForDispatch(row.businessId)], {
    type: "job.state",
    payload: { job: dto, event: eventToDto(updated.event) },
  });
  return dto;
}

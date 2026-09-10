import type { FastifyInstance } from "fastify";
import type { AppCtx } from "../ctx.js";
import { ACTIVE_JOB_STATUSES, TERMINAL_JOB_STATUSES } from "@ronmacrae/contracts";
import type { OpsBoardDto, OpsBoardOfferDto, OpsBoardOverdueJobDto, OpsBoardRiderDto, TrackingState } from "@ronmacrae/contracts";
import { pointFromJson } from "../geo-mappers.js";
import { jobInclude, jobSummaryToDto } from "./jobs/index.js";

/** A location older than this is shown as stale — the point itself is still
 *  displayed (it's the last thing we know), but flagged rather than implied
 *  to be where the rider actually is right now. Riders report roughly every
 *  15-30s while active (see LocationSimulator/geolocation.ts), so 5 minutes
 *  of silence is a genuine, not a nitpicky, warning sign. */
const STALE_LOCATION_MS = 5 * 60_000;

/**
 * Dispatcher/owner operations board (spec 5C) — one screen assembling what
 * would otherwise take several: rider availability/capacity/connectivity/
 * location, waiting offers, urgent and overdue jobs, and COD awaiting
 * handover. Read-only; every quick action it lists (assign, broadcast,
 * contact rider, inspect route queue) is an existing endpoint elsewhere —
 * this endpoint only aggregates what to show, never a new way to change
 * anything, so it carries no additional write-permission surface.
 */
export async function opsBoardRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/ops-board", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async () => {
    const now = new Date();

    const riders = await ctx.prisma.rider.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    const riderIds = riders.map((r) => r.id);

    const [activeCounts, latestLocations, openOffers, activeJobs, codJobs] = await Promise.all([
      ctx.prisma.job.groupBy({ by: ["riderId"], where: { riderId: { in: riderIds }, status: { in: [...ACTIVE_JOB_STATUSES] } }, _count: { _all: true } }),
      ctx.prisma.riderLocation.findMany({
        where: { riderId: { in: riderIds }, at: { gte: new Date(now.getTime() - 24 * 3600_000) } },
        orderBy: { at: "desc" },
      }),
      ctx.prisma.jobOffer.findMany({
        where: { status: "open", expiresAt: { gt: now } },
        include: { job: { select: { jobNumber: true, priority: true } }, rider: { select: { name: true } } },
        orderBy: { expiresAt: "asc" },
      }),
      ctx.prisma.job.findMany({
        where: { status: { in: [...ACTIVE_JOB_STATUSES] } },
        include: jobInclude,
      }),
      ctx.prisma.job.findMany({ where: { paymentMethod: "cod", codStatus: "handed_in" }, include: jobInclude, orderBy: { codHandoverAt: "asc" } }),
    ]);

    const activeCountByRider = new Map(activeCounts.map((c) => [c.riderId, c._count._all]));
    const latestByRider = new Map<string, (typeof latestLocations)[number]>();
    for (const loc of latestLocations) if (!latestByRider.has(loc.riderId)) latestByRider.set(loc.riderId, loc);

    const riderRows: OpsBoardRiderDto[] = riders.map((r) => {
      const loc = latestByRider.get(r.id);
      const ageMs = loc ? now.getTime() - loc.at.getTime() : null;
      return {
        id: r.id,
        name: r.name,
        phone: r.phone,
        status: r.status,
        availableForJobs: r.status === "available" || r.status === "on_job",
        activeJobCount: activeCountByRider.get(r.id) ?? 0,
        capacity: r.dailyCapacity,
        capacityRemaining: Math.max(0, r.dailyCapacity - (activeCountByRider.get(r.id) ?? 0)),
        connected: Boolean(ctx.hub.clientForRider(r.id)),
        location: loc
          ? {
              point: pointFromJson(loc.point)!,
              trackingState: loc.trackingState as TrackingState,
              at: loc.at.toISOString(),
              ageMs: ageMs!,
              stale: ageMs! > STALE_LOCATION_MS,
            }
          : null,
      };
    });

    const waitingOffers: OpsBoardOfferDto[] = openOffers.map((o) => ({
      id: o.id,
      jobId: o.jobId,
      jobNumber: o.job.jobNumber,
      riderId: o.riderId,
      riderName: o.rider.name,
      urgent: o.job.priority === "urgent",
      expiresAt: o.expiresAt.toISOString(),
      createdAt: o.createdAt.toISOString(),
    }));

    const urgentJobs = activeJobs.filter((j) => j.priority === "urgent").map((j) => jobSummaryToDto(j));

    const overdueJobs: OpsBoardOverdueJobDto[] = activeJobs
      .filter((j) => !TERMINAL_JOB_STATUSES.includes(j.status))
      .map((j) => {
        const due = j.promisedAt ?? j.scheduledAt;
        return due && due.getTime() < now.getTime()
          ? { id: j.id, jobNumber: j.jobNumber, status: j.status, priority: j.priority, riderName: j.rider?.name ?? null, dueAt: due.toISOString(), overdueByMs: now.getTime() - due.getTime() }
          : null;
      })
      .filter((x): x is OpsBoardOverdueJobDto => x !== null)
      .sort((a, b) => b.overdueByMs - a.overdueByMs);

    const codAwaitingHandover = codJobs.map((j) => jobSummaryToDto(j));

    const dto: OpsBoardDto = { riders: riderRows, waitingOffers, urgentJobs, overdueJobs, codAwaitingHandover, generatedAt: now.toISOString() };
    return dto;
  });
}

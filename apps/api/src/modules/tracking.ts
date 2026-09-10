import type { FastifyInstance } from "fastify";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import type { TrackingPublicDto } from "@ronmacrae/contracts";
import { toCustomerStatus } from "@ronmacrae/contracts";
import { pointFromJson, moneyField } from "../geo-mappers.js";
import {
  customerStatusHistory,
  createTrackingLink,
  getJobRow,
  latestRiderPoint,
  listEvents,
  revokeTrackingLinkByToken,
} from "./jobs/index.js";
import { getBusinessSettings } from "./settings.js";

/** Customer may see the delivery PIN only while the rider is en route. */
const PIN_VISIBLE_STATUSES = ["picked_up", "in_transit", "delivering"] as const;

/**
 * Public delivery tracking (no auth - the customer opens the link).
 *   POST /api/tracking/:jobId          staff: create/refresh the link
 *   GET  /api/tracking/:token          public: TrackingPublicDto
 *   POST /api/tracking/:token/revoke   staff: revoke
 */
export async function trackingRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const staff = ctx.requireStaff("admin", "dispatcher");

  app.post<{ Params: { jobId: string } }>("/api/tracking/:jobId", { preHandler: staff }, async (req) => {
    const link = await createTrackingLink(ctx, req.params.jobId);
    await ctx.audit.record(
      { id: req.user!.sub, role: req.user!.role },
      "tracking.create",
      "trackingLink",
      link.id,
      { jobId: req.params.jobId },
    );
    return { link };
  });

  app.post<{ Params: { token: string } }>("/api/tracking/:token/revoke", { preHandler: staff }, async (req) => {
    const link = await revokeTrackingLinkByToken(ctx, req.params.token);
    await ctx.audit.record(
      { id: req.user!.sub, role: req.user!.role },
      "tracking.revoke",
      "trackingLink",
      link.id,
    );
    return { link };
  });

  app.get<{ Params: { token: string } }>("/api/tracking/:token", async (req, reply) => {
    // basic anti-enumeration: expired/unknown links look alike
    reply.header("cache-control", "no-store");
    const link = await ctx.prisma.trackingLink.findUnique({ where: { token: req.params.token } });
    if (!link) {
      throw httpErrors.createError(410, "This tracking link is no longer valid");
    }
    const now = new Date();
    const expired = link.expiresAt <= now;
    if (link.lastAccessAt === null || link.lastAccessAt < new Date(now.getTime() - 60_000)) {
      await ctx.prisma.trackingLink
        .update({ where: { id: link.id }, data: { lastAccessAt: now } })
        .catch(() => undefined);
    }
    if (link.revoked) {
      throw httpErrors.createError(410, "This tracking link has been revoked");
    }

    const job = await ctx.prisma.job.findUnique({ where: { id: link.jobId } });
    if (!job) {
      throw httpErrors.createError(410, "This tracking link is no longer valid");
    }

    const status = job.status as TrackingPublicDto["job"]["status"];
    let etaAt: string | null = job.routeEta?.toISOString() ?? null;
    let locationPoint = null as { lat: number; lng: number } | null;
    let trackingState: TrackingPublicDto["location"]["trackingState"] = "unavailable";
    let locationUpdatedAt: string | null = null;
    let riderName: string | null = null;

    if (job.riderId) {
      const rider = await ctx.prisma.rider.findUnique({ where: { id: job.riderId } });
      riderName = rider?.name ?? null;
      const last = await ctx.prisma.riderLocation.findFirst({
        where: { riderId: job.riderId },
        orderBy: { at: "desc" },
      });
      if (last) {
        locationPoint = pointFromJson(last.point);
        trackingState = last.trackingState as TrackingPublicDto["location"]["trackingState"];
        locationUpdatedAt = last.at.toISOString();
      }
    }

    // freshest ETA: recompute when the rider has moved since the last one
    if (job.riderId && locationPoint && job.point) {
      const dropoff = pointFromJson(job.point);
      if (dropoff) {
        const { haversineM } = await import("@ronmacrae/geo");
        const fresh = new Date(Date.now() + (haversineM(locationPoint, dropoff) / 8) * 1000);
        if (!job.routeEta || fresh.getTime() > job.routeEta.getTime()) {
          etaAt = fresh.toISOString();
        }
      }
    }

    const history = await customerStatusHistory(ctx, job.id);
    const out: TrackingPublicDto = {
      token: link.token,
      expired,
      job: {
        id: job.id,
        jobNumber: job.jobNumber,
        status,
        customerStatus: toCustomerStatus(status as (typeof toCustomerStatus extends (s: infer S) => unknown ? S : never)),
        customerName: (
          await ctx.prisma.customer.findUnique({ where: { id: job.customerId }, select: { name: true } })
        )?.name ?? "Customer",
        addressText: job.addressText,
        landmark: job.landmark,
        itemSummary: job.itemSummary,
        scheduledAt: job.scheduledAt?.toISOString() ?? null,
        promisedAt: job.promisedAt?.toISOString() ?? null,
        completedAt: job.completedAt?.toISOString() ?? null,
        failureReason: job.failureReason,
        pin: PIN_VISIBLE_STATUSES.includes(status as (typeof PIN_VISIBLE_STATUSES)[number]) ? job.pin : null,
        amountExpected: moneyField(job.amountExpected, job.currency),
        paymentMethod: job.paymentMethod,
      },
      rider: job.riderId
        ? (await ctx.prisma.rider.findUnique({ where: { id: job.riderId } }))
          ? {
              name: riderName ?? "Courier",
              photoUrl: (await ctx.prisma.rider.findUnique({ where: { id: job.riderId }, select: { photoUrl: true } }))?.photoUrl ?? null,
              vehicle: null,
              plate: null,
              phone: null,
            }
          : null
        : null,
      location: {
        point: locationPoint,
        trackingState,
        etaAt,
        updatedAt: locationUpdatedAt,
      },
      statusHistory: history,
      generatedAt: now.toISOString(),
    };
    return out;
  });
}

export { getBusinessSettings };

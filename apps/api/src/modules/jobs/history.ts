import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../../ctx.js";
import type { JobEventDto, JobStatus, TrackingLinkDto } from "@ronmacrae/contracts";
import { toCustomerStatus, type CustomerJobStatus } from "@ronmacrae/contracts";
import { randomToken } from "../../lib/ids.js";
import { getBusinessSettings } from "../settings.js";
import { JobNotifier } from "../notify.js";
import { assertJobBusiness, eventToDto, linkToDto, type Viewer } from "./dto.js";
import { getJobRow, listEvents } from "./repository.js";

/**
 * Full event history for a job (status changes, stage updates, collections,
 * edits) - oldest first. Powers the staff "status history" panel.
 */
export async function jobEventHistory(ctx: AppCtx, jobId: string, viewer: Viewer): Promise<JobEventDto[]> {
  const job = await getJobRow(ctx, jobId);
  if (!job) throw httpErrors.createError(404, "Job not found");
  assertJobBusiness(viewer, job.businessId);
  const events = await listEvents(ctx, jobId);
  return events.map(eventToDto);
}

/**
 * Customer-facing history for the tracking page: internal statuses projected
 * to customer wording with consecutive duplicates collapsed.
 */
export async function customerStatusHistory(
  ctx: AppCtx,
  jobId: string,
): Promise<{ status: CustomerJobStatus; at: string }[]> {
  const events = await listEvents(ctx, jobId);
  const out: { status: CustomerJobStatus; at: string }[] = [];
  for (const e of events) {
    // skip stage/meta events (from === to on a non-transition) - but keep the
    // first occurrence of each customer status
    const customerStatus = toCustomerStatus(e.to as JobStatus);
    const last = out[out.length - 1];
    if (!last || last.status !== customerStatus) {
      out.push({ status: customerStatus, at: e.at.toISOString() });
    }
  }
  return out;
}

/**
 * Create (or refresh) the customer tracking link for a job. Idempotent: an
 * unexpired, unrevoked link is returned unchanged.
 */
export async function createTrackingLink(ctx: AppCtx, jobId: string, viewer: Viewer): Promise<TrackingLinkDto> {
  const job = await getJobRow(ctx, jobId);
  if (!job) throw httpErrors.createError(404, "Job not found");
  assertJobBusiness(viewer, job.businessId);
  const existing = await ctx.prisma.trackingLink.findUnique({ where: { jobId } });
  const business = await getBusinessSettings(ctx, job.businessId);
  const ttlHours = business.trackingLinkTtlHours;
  const now = new Date();
  if (existing && !existing.revoked && existing.expiresAt > now) {
    return linkToDto(existing, ctx.config.APP_ORIGIN);
  }
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  const link = existing
    ? await ctx.prisma.trackingLink.update({
        where: { jobId },
        data: { token, expiresAt, revoked: false, lastAccessAt: null },
      })
    : await ctx.prisma.trackingLink.create({
        data: { jobId, token, expiresAt },
      });
  const dto = linkToDto(link, ctx.config.APP_ORIGIN);
  // The very first tracking link for a job is the "order confirmed" moment —
  // a later refresh (existing branch above) is not a new order, so it's
  // never re-sent then.
  if (!existing && job.customer.consentTracking) {
    await new JobNotifier(ctx.notify)
      .forOrderCreated({
        job: {
          id: job.id,
          externalRef: job.externalRef,
          customerName: job.customer.name,
          customerPhone: job.customer.phone,
          failureReason: null,
          routeEta: null,
          completedAt: null,
        },
        linkUrl: dto.url,
        riderName: job.rider?.name ?? null,
        business: business.businessName,
        dispatchPhone: business.dispatchPhone,
        ttlHours,
      })
      .catch((err) => ctx.log.error({ err: String(err), jobId }, "order-created notification failed"));
  }
  return dto;
}

/** Revoke a tracking link by its token. */
export async function revokeTrackingLinkByToken(ctx: AppCtx, token: string, viewer: Viewer): Promise<TrackingLinkDto> {
  const link = await ctx.prisma.trackingLink.findUnique({ where: { token }, include: { job: { select: { businessId: true } } } });
  if (!link) throw httpErrors.createError(404, "Tracking link not found");
  assertJobBusiness(viewer, link.job.businessId);
  const revoked = await ctx.prisma.trackingLink.update({
    where: { token },
    data: { revoked: true },
  });
  return linkToDto(revoked, ctx.config.APP_ORIGIN);
}

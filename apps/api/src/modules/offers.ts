import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { moneyField } from "../geo-mappers.js";
import { ACTIVE_JOB_STATUSES, roomForDispatch, roomForJob, roomForRider } from "@ronmacrae/contracts";
import type { JobOfferDto } from "@ronmacrae/contracts";
import { actorType, eventToDto, jobInclude, jobToDto, type Actor, type Viewer } from "./jobs/index.js";

const BroadcastBody = z.object({
  expiresInMinutes: z.number().int().min(1).max(120).default(15),
  riderIds: z.array(z.string().min(1)).max(100).optional(),
});
const NoteBody = z.object({ note: z.string().max(300).optional().or(z.literal("")) });

const actorFor = (req: FastifyRequest): Actor => ({ id: req.user!.sub, name: req.user!.name, role: req.user!.role, riderId: req.user!.riderId });
const viewerFor = (req: FastifyRequest): Viewer => ({ role: req.user!.role, riderId: req.user!.riderId });

type OfferRow = {
  id: string;
  jobId: string;
  status: "open" | "accepted" | "declined" | "withdrawn" | "expired";
  expiresAt: Date;
  createdAt: Date;
  job: {
    pickupAddressText: string | null;
    addressText: string | null;
    zone: { name: string } | null;
    merchant: { name: string } | null;
    itemSummary: string | null;
    fee: number | null;
    amountExpected: number | null;
    currency: string;
    priority: string;
  };
  rider: { id: string; name: string; payRate: number | null; payCurrency: string };
};

/** `includeRider` is staff-only (dispatcher offers list) — a rider's own offers already imply their identity. */
function dto(row: OfferRow, opts: { includeRider?: boolean } = {}): JobOfferDto {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    pickupArea: row.job.pickupAddressText,
    destinationArea: row.job.zone?.name ?? row.job.addressText,
    merchantName: row.job.merchant?.name ?? null,
    itemSummary: row.job.itemSummary,
    deliveryFee: moneyField(row.job.fee, row.job.currency),
    riderEarnings: moneyField(row.rider.payRate, row.rider.payCurrency),
    codAmount: moneyField(row.job.amountExpected, row.job.currency),
    requestedAt: null,
    createdAt: row.createdAt.toISOString(),
    urgent: row.job.priority === "urgent",
    ...(opts.includeRider ? { riderId: row.rider.id, riderName: row.rider.name } : {}),
  };
}

/** Lazily flip past-due open offers to `expired` (called at the top of every offer-reading route). */
async function expire(ctx: AppCtx): Promise<void> {
  await ctx.prisma.jobOffer.updateMany({ where: { status: "open", expiresAt: { lte: new Date() } }, data: { status: "expired" } });
}

/**
 * Active, capacity-checked riders eligible for a fresh offer at `businessId`,
 * optionally scoped to a subset of rider ids. Shared by broadcast and
 * rebroadcast so rebroadcast can no longer skip the daily-capacity check the
 * first broadcast enforces.
 *
 * Business isolation: a rider is only eligible if they hold an *active*
 * RiderMembership at THIS business — being globally `active`/`available`
 * is necessary but not sufficient. A rider who works for two businesses
 * only ever receives the offers of whichever one actually invited them.
 *
 * Attachment (spec: Bearer/Logistics companies + merchant-attached riders,
 * see RiderAttachment's doc comment in schema.prisma): `freelance` (the
 * default, and every pre-existing rider's value) is unrestricted — identical
 * to this function's behavior before attachment existed. A rider whose
 * `platformStatus` is `approved` is always eligible regardless of
 * attachment — the Platform Admin's explicit "eligible for marketplace
 * work" override wins over any attachment restriction. Otherwise:
 * `merchant`-attached riders are only eligible for jobs placed by the one
 * merchant they're attached to; `logistics`-attached riders are only
 * eligible for direct/in-house jobs (`job.merchantId === null`) — a
 * logistics company's riders don't automatically also serve merchant
 * orders unless the Platform Admin has approved them for marketplace work.
 */
async function eligibleRiders(ctx: AppCtx, businessId: string, jobMerchantId: string | null, riderIds?: string[]) {
  const riders = await ctx.prisma.rider.findMany({
    where: {
      active: true,
      status: "available",
      ...(riderIds ? { id: { in: riderIds } } : {}),
      memberships: { some: { businessId, status: "active" } },
    },
  });
  const eligible: typeof riders = [];
  for (const rider of riders) {
    if (rider.platformStatus !== "approved") {
      if (rider.attachment === "merchant" && rider.attachedMerchantId !== jobMerchantId) continue;
      if (rider.attachment === "logistics" && jobMerchantId !== null) continue;
    }
    const active = await ctx.prisma.job.count({ where: { riderId: rider.id, status: { in: [...ACTIVE_JOB_STATUSES] } } });
    if (active < rider.dailyCapacity) eligible.push(rider);
  }
  return eligible;
}

/** Create offers for the given job/riders in one transaction and broadcast them over the hub. */
async function createOffers(ctx: AppCtx, jobId: string, businessId: string, riders: { id: string }[], expiresAt: Date) {
  const offers = await ctx.prisma.$transaction((tx) =>
    Promise.all(
      riders.map((rider) =>
        tx.jobOffer.create({
          data: { jobId, businessId, riderId: rider.id, expiresAt },
          include: { job: { include: { zone: true, merchant: true } }, rider: true },
        }),
      ),
    ),
  );
  for (const offer of offers) {
    // The rider's own room gets the un-scoped dto (no riderId/riderName — the rider
    // already knows who they are); dispatch gets the staff-shaped dto so a live
    // offers panel can identify which rider it's for. Only THIS business's dispatch
    // room — a rider shared with another business never leaks this offer to it.
    ctx.hub.broadcast(roomForRider(offer.riderId), { type: "offer", payload: dto(offer) });
    ctx.hub.broadcast(roomForDispatch(businessId), { type: "offer", payload: dto(offer, { includeRider: true }) });
    // Best-effort: reaches a rider even if the app is backgrounded/closed. Never blocks
    // or fails the broadcast/rebroadcast response — PushService already swallows
    // per-subscription send errors internally.
    void ctx.push
      .sendToRider(offer.riderId, {
        title: "New delivery offer",
        body: [offer.job.pickupAddressText, offer.job.zone?.name ?? offer.job.addressText].filter(Boolean).join(" → ") || "Open the app to view details",
        tag: `offer-${offer.id}`,
        url: "/",
      })
      .catch((err) => ctx.log.error({ err: String(err), offerId: offer.id }, "offer push notification failed"));
  }
  return offers;
}

export async function offerRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const writer = ctx.requireStaff("admin", "dispatcher");

  app.post<{ Params: { id: string } }>("/api/jobs/:id/offers/broadcast", { preHandler: writer }, async (req) => {
    const body = BroadcastBody.parse(req.body ?? {});
    await expire(ctx);
    const businessId = req.user!.businessId!;
    const job = await ctx.prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job || job.businessId !== businessId) throw httpErrors.createError(404, "Job not found");
    if (job.status !== "new" || job.riderId) throw httpErrors.createError(409, "Only unassigned new jobs can be broadcast");
    const eligible = await eligibleRiders(ctx, businessId, job.merchantId, body.riderIds);
    const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60_000);
    const offers = await createOffers(ctx, job.id, businessId, eligible, expiresAt);
    await ctx.audit.record(actorFor(req), "offer.broadcast", "job", job.id, { eligibleRiders: eligible.length, expiresAt });
    return { offers: offers.map((o) => dto(o, { includeRider: true })) };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/offers", { preHandler: writer }, async (req) => {
    await expire(ctx);
    const offers = await ctx.prisma.jobOffer.findMany({
      where: { jobId: req.params.id, businessId: req.user!.businessId! },
      orderBy: { createdAt: "desc" },
      include: { job: { include: { zone: true, merchant: true } }, rider: true },
    });
    return { offers: offers.map((o) => dto(o, { includeRider: true })) };
  });

  app.post<{ Params: { id: string } }>("/api/offers/:id/withdraw", { preHandler: writer }, async (req) => {
    const body = NoteBody.parse(req.body ?? {});
    const updated = await ctx.prisma.jobOffer.updateMany({ where: { id: req.params.id, businessId: req.user!.businessId!, status: "open" }, data: { status: "withdrawn", note: body.note || null } });
    if (!updated.count) throw httpErrors.createError(409, "Offer is no longer open");
    await ctx.audit.record(actorFor(req), "offer.withdraw", "offer", req.params.id, { note: body.note || null });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/offers/rebroadcast", { preHandler: writer }, async (req) => {
    const body = BroadcastBody.parse(req.body ?? {});
    const businessId = req.user!.businessId!;
    const old = await ctx.prisma.jobOffer.updateMany({ where: { jobId: req.params.id, businessId, status: "open" }, data: { status: "withdrawn", note: "rebroadcast" } });
    const job = await ctx.prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job || job.businessId !== businessId) throw httpErrors.createError(404, "Job not found");
    if (job.status !== "new" || job.riderId) throw httpErrors.createError(409, "Only unassigned new jobs can be rebroadcast");
    const eligible = await eligibleRiders(ctx, businessId, job.merchantId, body.riderIds);
    const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60_000);
    const offers = await createOffers(ctx, job.id, businessId, eligible, expiresAt);
    await ctx.audit.record(actorFor(req), "offer.rebroadcast", "job", job.id, { withdrawn: old.count, offered: offers.length });
    return { offers: offers.map((o) => dto(o, { includeRider: true })) };
  });

  app.get("/api/bearer/offers", { preHandler: ctx.requireRider }, async (req) => {
    await expire(ctx);
    const offers = await ctx.prisma.jobOffer.findMany({
      where: { riderId: req.user!.riderId!, status: "open", expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: "asc" },
      include: { job: { include: { zone: true, merchant: true } }, rider: true },
    });
    return { offers: offers.map((o) => dto(o)) };
  });

  app.post<{ Params: { id: string } }>("/api/bearer/offers/:id/decline", { preHandler: ctx.requireRider }, async (req) => {
    const body = NoteBody.parse(req.body ?? {});
    const changed = await ctx.prisma.jobOffer.updateMany({
      where: { id: req.params.id, riderId: req.user!.riderId!, status: "open", expiresAt: { gt: new Date() } },
      data: { status: "declined", note: body.note || null },
    });
    if (!changed.count) throw httpErrors.createError(409, "Offer is no longer available");
    await ctx.audit.record(actorFor(req), "offer.decline", "offer", req.params.id, { note: body.note || null });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/bearer/offers/:id/accept", { preHandler: ctx.requireRider }, async (req) => {
    await expire(ctx);
    const riderId = req.user!.riderId!;
    const actor = actorFor(req);
    const result = await ctx.prisma.$transaction(async (tx) => {
      const offer = await tx.jobOffer.findFirst({ where: { id: req.params.id, riderId, status: "open", expiresAt: { gt: new Date() } } });
      if (!offer) throw httpErrors.createError(409, "Offer is no longer available");
      // A membership can be suspended between the offer being sent and the
      // rider tapping Accept — re-check it's still active at accept time,
      // not just when the offer went out.
      const membership = await tx.riderMembership.findUnique({ where: { riderId_businessId: { riderId, businessId: offer.businessId } } });
      if (membership?.status !== "active") throw httpErrors.createError(409, "You're no longer an active rider for this business");
      // Conditional claim: only succeeds if the job is still unassigned `new`. This is the
      // single point of truth that prevents two riders (or a rider and a dispatcher manual
      // assignment) from both winning the same job.
      // Straight to `accepted` (not the intermediate `assigned`) — a rider who
      // just accepted an offer has already said yes; making them tap a second
      // "Accept job" button on the very next screen was the confusing
      // double-accept this flow used to force. A job a dispatcher assigns
      // *without* an offer still lands on `assigned` (see assignJob) and does
      // need that one rider confirmation — this is the only path that gets to
      // skip it, because the offer itself already was that confirmation.
      const claimed = await tx.job.updateMany({
        where: { id: offer.jobId, status: "new", riderId: null },
        data: { riderId, status: "accepted", stage: "heading_to_pickup" },
      });
      if (!claimed.count) throw httpErrors.createError(409, "Another rider has already claimed this job");
      // Capacity was checked when this offer (and any others still open for this
      // rider) was broadcast, but a rider can hold several open offers from
      // separate broadcasts at once now that carrying jobs no longer excludes
      // them from new ones — re-check inside the same transaction as the claim
      // so accepting several of them near-simultaneously can't push the rider
      // over their configured limit. Throwing here rolls back the claim above,
      // leaving the job unassigned for another rider rather than double-booking.
      const rider = await tx.rider.findUniqueOrThrow({ where: { id: riderId } });
      const activeCount = await tx.job.count({ where: { riderId, status: { in: [...ACTIVE_JOB_STATUSES] } } });
      if (activeCount > rider.dailyCapacity) {
        throw httpErrors.createError(409, `You're at capacity (${activeCount}/${rider.dailyCapacity} active jobs) — decline or finish a job before accepting another`);
      }
      await tx.jobOffer.updateMany({ where: { jobId: offer.jobId, status: "open" }, data: { status: "withdrawn", note: "claimed" } });
      await tx.jobOffer.update({ where: { id: offer.id }, data: { status: "accepted" } });
      await tx.riderAssignment.create({ data: { jobId: offer.jobId, riderId, status: "assigned", reason: "offer accepted" } });
      const job = await tx.job.findUniqueOrThrow({ where: { id: offer.jobId }, include: jobInclude });
      const event = await tx.jobEvent.create({
        data: {
          jobId: offer.jobId,
          from: "new",
          to: "accepted",
          actorType: actorType("rider"),
          actorId: actor.id,
          actorName: actor.name,
          note: "offer accepted",
          meta: { offerId: offer.id },
        },
      });
      return { job, event };
    });
    const job = jobToDto(result.job, viewerFor(req), ctx.config.APP_ORIGIN);
    const eventDto = eventToDto(result.event);
    const dispatchRoom = roomForDispatch(result.job.businessId);
    ctx.hub.broadcastMany([dispatchRoom, roomForRider(riderId)], { type: "job.assigned", payload: { job, riderId, source: "offer" } });
    ctx.hub.broadcastMany([roomForJob(job.id), dispatchRoom], { type: "job.state", payload: { job, event: eventDto } });
    await ctx.audit.record(actor, "offer.accept", "job", job.id, { offerId: req.params.id });
    return { job };
  });
}

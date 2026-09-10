import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { moneyField } from "../geo-mappers.js";
import { ACTIVE_JOB_STATUSES, ROOM_DISPATCH, roomForJob, roomForRider } from "@ronmacrae/contracts";
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
    itemSummary: string | null;
    fee: number | null;
    amountExpected: number | null;
    currency: string;
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
    itemSummary: row.job.itemSummary,
    deliveryFee: moneyField(row.job.fee, row.job.currency),
    riderEarnings: moneyField(row.rider.payRate, row.rider.payCurrency),
    codAmount: moneyField(row.job.amountExpected, row.job.currency),
    requestedAt: null,
    createdAt: row.createdAt.toISOString(),
    ...(opts.includeRider ? { riderId: row.rider.id, riderName: row.rider.name } : {}),
  };
}

/** Lazily flip past-due open offers to `expired` (called at the top of every offer-reading route). */
async function expire(ctx: AppCtx): Promise<void> {
  await ctx.prisma.jobOffer.updateMany({ where: { status: "open", expiresAt: { lte: new Date() } }, data: { status: "expired" } });
}

/**
 * Active, capacity-checked riders eligible for a fresh offer, optionally scoped to a
 * subset of rider ids. Shared by broadcast and rebroadcast so rebroadcast can no longer
 * skip the daily-capacity check the first broadcast enforces.
 */
async function eligibleRiders(ctx: AppCtx, riderIds?: string[]) {
  const riders = await ctx.prisma.rider.findMany({
    where: { active: true, status: "available", ...(riderIds ? { id: { in: riderIds } } : {}) },
  });
  const eligible: typeof riders = [];
  for (const rider of riders) {
    const active = await ctx.prisma.job.count({ where: { riderId: rider.id, status: { in: [...ACTIVE_JOB_STATUSES] } } });
    if (active < rider.dailyCapacity) eligible.push(rider);
  }
  return eligible;
}

/** Create offers for the given job/riders in one transaction and broadcast them over the hub. */
async function createOffers(ctx: AppCtx, jobId: string, riders: { id: string }[], expiresAt: Date) {
  const offers = await ctx.prisma.$transaction((tx) =>
    Promise.all(
      riders.map((rider) =>
        tx.jobOffer.create({
          data: { jobId, riderId: rider.id, expiresAt },
          include: { job: { include: { zone: true } }, rider: true },
        }),
      ),
    ),
  );
  for (const offer of offers) {
    // The rider's own room gets the un-scoped dto (no riderId/riderName — the rider
    // already knows who they are); dispatch gets the staff-shaped dto so a live
    // offers panel can identify which rider it's for.
    ctx.hub.broadcast(roomForRider(offer.riderId), { type: "offer", payload: dto(offer) });
    ctx.hub.broadcast(ROOM_DISPATCH, { type: "offer", payload: dto(offer, { includeRider: true }) });
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
    const job = await ctx.prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job || job.status !== "new" || job.riderId) throw httpErrors.createError(409, "Only unassigned new jobs can be broadcast");
    const eligible = await eligibleRiders(ctx, body.riderIds);
    const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60_000);
    const offers = await createOffers(ctx, job.id, eligible, expiresAt);
    await ctx.audit.record(actorFor(req), "offer.broadcast", "job", job.id, { eligibleRiders: eligible.length, expiresAt });
    return { offers: offers.map((o) => dto(o, { includeRider: true })) };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/offers", { preHandler: writer }, async (req) => {
    await expire(ctx);
    const offers = await ctx.prisma.jobOffer.findMany({
      where: { jobId: req.params.id },
      orderBy: { createdAt: "desc" },
      include: { job: { include: { zone: true } }, rider: true },
    });
    return { offers: offers.map((o) => dto(o, { includeRider: true })) };
  });

  app.post<{ Params: { id: string } }>("/api/offers/:id/withdraw", { preHandler: writer }, async (req) => {
    const body = NoteBody.parse(req.body ?? {});
    const updated = await ctx.prisma.jobOffer.updateMany({ where: { id: req.params.id, status: "open" }, data: { status: "withdrawn", note: body.note || null } });
    if (!updated.count) throw httpErrors.createError(409, "Offer is no longer open");
    await ctx.audit.record(actorFor(req), "offer.withdraw", "offer", req.params.id, { note: body.note || null });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/offers/rebroadcast", { preHandler: writer }, async (req) => {
    const body = BroadcastBody.parse(req.body ?? {});
    const old = await ctx.prisma.jobOffer.updateMany({ where: { jobId: req.params.id, status: "open" }, data: { status: "withdrawn", note: "rebroadcast" } });
    const job = await ctx.prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job || job.status !== "new" || job.riderId) throw httpErrors.createError(409, "Only unassigned new jobs can be rebroadcast");
    const eligible = await eligibleRiders(ctx, body.riderIds);
    const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60_000);
    const offers = await createOffers(ctx, job.id, eligible, expiresAt);
    await ctx.audit.record(actorFor(req), "offer.rebroadcast", "job", job.id, { withdrawn: old.count, offered: offers.length });
    return { offers: offers.map((o) => dto(o, { includeRider: true })) };
  });

  app.get("/api/bearer/offers", { preHandler: ctx.requireRider }, async (req) => {
    await expire(ctx);
    const offers = await ctx.prisma.jobOffer.findMany({
      where: { riderId: req.user!.riderId!, status: "open", expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: "asc" },
      include: { job: { include: { zone: true } }, rider: true },
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
      // Conditional claim: only succeeds if the job is still unassigned `new`. This is the
      // single point of truth that prevents two riders (or a rider and a dispatcher manual
      // assignment) from both winning the same job.
      const claimed = await tx.job.updateMany({
        where: { id: offer.jobId, status: "new", riderId: null },
        data: { riderId, status: "assigned", stage: "heading_to_pickup" },
      });
      if (!claimed.count) throw httpErrors.createError(409, "Another rider has already claimed this job");
      await tx.jobOffer.updateMany({ where: { jobId: offer.jobId, status: "open" }, data: { status: "withdrawn", note: "claimed" } });
      await tx.jobOffer.update({ where: { id: offer.id }, data: { status: "accepted" } });
      await tx.riderAssignment.create({ data: { jobId: offer.jobId, riderId, status: "assigned", reason: "offer accepted" } });
      const job = await tx.job.findUniqueOrThrow({ where: { id: offer.jobId }, include: jobInclude });
      const event = await tx.jobEvent.create({
        data: {
          jobId: offer.jobId,
          from: "new",
          to: "assigned",
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
    ctx.hub.broadcastMany([ROOM_DISPATCH, roomForRider(riderId)], { type: "job.assigned", payload: { job, riderId } });
    ctx.hub.broadcastMany([roomForJob(job.id), ROOM_DISPATCH], { type: "job.state", payload: { job, event: eventDto } });
    await ctx.audit.record(actor, "offer.accept", "job", job.id, { offerId: req.params.id });
    return { job };
  });
}

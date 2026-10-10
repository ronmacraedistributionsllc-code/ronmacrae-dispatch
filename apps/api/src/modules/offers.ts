import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { Prisma } from "@prisma/client";
import type { AppCtx } from "../ctx.js";
import { idempotencyKeyFrom, withIdempotency } from "../lib/idempotency.js";
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

export type CourierPool = "company" | "free_roam" | "both";

/**
 * Active, capacity-checked riders eligible for a fresh offer at `businessId`,
 * optionally scoped to a subset of rider ids. Shared by manual broadcast,
 * rebroadcast, and auto-broadcast so none of them can skip the
 * daily-capacity check the first broadcast enforces.
 *
 * Business isolation: a rider is only eligible if they hold an *active*
 * RiderMembership at THIS business — being globally `active`/`available`
 * is necessary but not sufficient. A rider who works for two businesses
 * only ever receives the offers of whichever one actually invited them.
 * The one exception is the business's own courier-pool choice (see the
 * CourierPool doc comment in schema.prisma): when the pool is `free_roam`
 * or `both`, marketplace-approved riders (`platformStatus: approved`,
 * vetted by the Platform Admin) are eligible WITHOUT a membership at
 * this business — accepting auto-creates their membership (see
 * ensureClaimMembership). With the default `company` pool this function
 * behaves exactly as before.
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
async function eligibleRiders(
  ctx: AppCtx,
  businessId: string,
  jobMerchantId: string | null,
  riderIds?: string[],
  pool: CourierPool = "company",
) {
  const riders = await ctx.prisma.rider.findMany({
    where: {
      active: true,
      status: "available",
      ...(riderIds ? { id: { in: riderIds } } : {}),
      ...(pool === "free_roam"
        // Free-roam pool: marketplace-approved riders only, membership or
        // not — the business opted into the open network for this job.
        ? { platformStatus: "approved" }
        : { memberships: { some: { businessId, status: "active" } } }),
    },
  });
  const eligible: typeof riders = [];
  const seen = new Set<string>();
  // `both` = company members plus marketplace-approved free-roam riders.
  const extra =
    pool === "both"
      ? await ctx.prisma.rider.findMany({
          where: {
            active: true,
            status: "available",
            platformStatus: "approved",
            ...(riderIds ? { id: { in: riderIds } } : {}),
          },
        })
      : [];
  for (const rider of [...riders, ...extra]) {
    if (seen.has(rider.id)) continue;
    seen.add(rider.id);
    // Free-roam riders arrive via the marketplace override, so attachment
    // never restricts them; company members follow the attachment rules.
    // (Pure-`company` pools only ever contain members, so skip the lookup.)
    const isFreeRoam =
      pool !== "company" && rider.platformStatus === "approved" && !(await isActiveMember(ctx, rider.id, businessId));
    if (!isFreeRoam && rider.platformStatus !== "approved") {
      if (rider.attachment === "merchant" && rider.attachedMerchantId !== jobMerchantId) continue;
      if (rider.attachment === "logistics" && jobMerchantId !== null) continue;
    }
    const active = await ctx.prisma.job.count({ where: { riderId: rider.id, status: { in: [...ACTIVE_JOB_STATUSES] } } });
    if (active < rider.dailyCapacity) eligible.push(rider);
  }
  return eligible;
}

async function isActiveMember(ctx: AppCtx, riderId: string, businessId: string): Promise<boolean> {
  const m = await ctx.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId, businessId } } });
  return m?.status === "active";
}

/**
 * The membership gate shared by offer-accept and pending-claim. Returns how
 * the rider is covered: an active member as-is, or — when the rider is
 * marketplace-approved and this business's pool allows free-roam — by
 * auto-creating their membership on the spot (the business opted into the
 * open network, which IS the admin's approval for these riders; the
 * Platform Admin's vetting is the other half). Anything else is the same
 * 409 the accept path always returned.
 */
async function ensureClaimMembership(
  ctx: AppCtx,
  businessId: string,
  pool: CourierPool,
  riderId: string,
): Promise<"member" | "free_roam"> {
  if (await isActiveMember(ctx, riderId, businessId)) return "member";
  if (pool !== "company") {
    const rider = await ctx.prisma.rider.findUnique({ where: { id: riderId } });
    if (rider?.active && rider.platformStatus === "approved") {
      await ctx.prisma.riderMembership.upsert({
        where: { riderId_businessId: { riderId, businessId } },
        create: { riderId, businessId, status: "active", approvedAt: new Date() },
        update: { status: "active", approvedAt: new Date() },
      });
      return "free_roam";
    }
  }
  throw httpErrors.createError(409, "You're no longer an active courier for this business");
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
      .sendToRider(
        offer.riderId,
        {
          title: "New delivery offer",
          body: [offer.job.pickupAddressText, offer.job.zone?.name ?? offer.job.addressText].filter(Boolean).join(" → ") || "Open the app to view details",
          tag: `offer-${offer.id}`,
          url: "/",
        },
        { kind: "offer" },
      )
      .catch((err) => ctx.log.error({ err: String(err), offerId: offer.id }, "offer push notification failed"));
  }
  return offers;
}

interface ClaimInput {
  jobId: string;
  riderId: string;
  actor: Actor;
  /** "offer accepted" vs "pending list claimed" — surfaced in events/audit. */
  note: string;
  meta: Record<string, unknown>;
  assignmentReason: string;
  /** When claiming via an offer, flip that one offer to `accepted` inside
   *  the same transaction (the blanket withdraw above would otherwise
   *  catch it too). Pending-list claims pass none. */
  acceptedOfferId?: string;
}

/**
 * The single conditional-claim transaction shared by offer-accept and
 * pending-list claim: wins only if the job is still unassigned `new`,
 * re-checks capacity inside the same transaction (accepting several
 * offers near-simultaneously can't overbook), withdraws every other open
 * offer for the job, and records the assignment + event. Returns the
 * full job + event rows for dto mapping.
 */
async function claimJobTx(tx: Prisma.TransactionClient, ctx: AppCtx, input: ClaimInput) {
  const claimed = await tx.job.updateMany({
    where: { id: input.jobId, status: "new", riderId: null },
    data: { riderId: input.riderId, status: "accepted", stage: "heading_to_pickup" },
  });
  if (!claimed.count) throw httpErrors.createError(409, "Another courier has already claimed this job");
  // Capacity was checked when this offer (and any others still open for this
  // rider) was broadcast, but a rider can hold several open offers from
  // separate broadcasts at once now that carrying jobs no longer excludes
  // them from new ones — re-check inside the same transaction as the claim
  // so accepting several of them near-simultaneously can't push the rider
  // over their configured limit. Throwing here rolls back the claim above,
  // leaving the job unassigned for another rider rather than double-booking.
  const rider = await tx.rider.findUniqueOrThrow({ where: { id: input.riderId } });
  const activeCount = await tx.job.count({ where: { riderId: input.riderId, status: { in: [...ACTIVE_JOB_STATUSES] } } });
  if (activeCount > rider.dailyCapacity) {
    throw httpErrors.createError(409, `You're at capacity (${activeCount}/${rider.dailyCapacity} active jobs) — decline or finish a job before accepting another`);
  }
  await tx.jobOffer.updateMany({ where: { jobId: input.jobId, status: "open" }, data: { status: "withdrawn", note: "claimed" } });
  if (input.acceptedOfferId) await tx.jobOffer.update({ where: { id: input.acceptedOfferId }, data: { status: "accepted" } });
  await tx.riderAssignment.create({ data: { jobId: input.jobId, riderId: input.riderId, status: "assigned", reason: input.assignmentReason } });
  const job = await tx.job.findUniqueOrThrow({ where: { id: input.jobId }, include: jobInclude });
  const event = await tx.jobEvent.create({
    data: {
      jobId: input.jobId,
      from: "new",
      to: "accepted",
      actorType: actorType("rider"),
      actorId: input.actor.id,
      actorName: input.actor.name,
      note: input.note,
      meta: input.meta as object,
    },
  });
  return { job, event };
}

/** This business's auto-dispatch knobs (one row read, no joins). */
async function dispatchPool(ctx: AppCtx, businessId: string): Promise<{ autoBroadcast: boolean; pool: CourierPool; expiryMinutes: number }> {
  const row = await ctx.prisma.business.findUnique({ where: { id: businessId } });
  return {
    autoBroadcast: row?.autoBroadcastOffers ?? true,
    pool: (row?.courierPool as CourierPool | undefined) ?? "company",
    expiryMinutes: row?.offerExpiryMinutes ?? 15,
  };
}

/**
 * Auto-dispatch: offer a newly created job to every eligible courier.
 * Best-effort and never failing — creation paths await it, but only a
 * few indexed writes happen synchronously (fan-out stays async inside
 * createOffers) and every failure path returns `{ offered: 0 }` instead
 * of throwing. No-ops when the business disabled auto-broadcast, when
 * the job is no longer unassigned `new` (e.g. merchant-direct-assign
 * won the race), or when nobody is eligible (the job simply waits in
 * the pending-jobs list for couriers to claim).
 */
export async function autoBroadcastNewJob(ctx: AppCtx, jobId: string): Promise<{ offered: number }> {
  try {
    const job = await ctx.prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.status !== "new" || job.riderId) return { offered: 0 };
    const { autoBroadcast, pool, expiryMinutes } = await dispatchPool(ctx, job.businessId);
    if (!autoBroadcast) return { offered: 0 };
    await expire(ctx);
    const eligible = await eligibleRiders(ctx, job.businessId, job.merchantId, undefined, pool);
    if (eligible.length === 0) {
      ctx.log.info({ jobId, businessId: job.businessId }, "auto-broadcast: no eligible couriers — job waits in pending list");
      return { offered: 0 };
    }
    const expiresAt = new Date(Date.now() + expiryMinutes * 60_000);
    const offers = await createOffers(ctx, job.id, job.businessId, eligible, expiresAt);
    await ctx.audit.record({ id: null, role: null }, "offer.auto_broadcast", "job", job.id, { eligibleRiders: eligible.length, pool, expiresAt });
    return { offered: offers.length };
  } catch (err) {
    // Creation already succeeded — a broadcast failure is logged, never thrown.
    ctx.log.error({ err: String(err), jobId }, "auto-broadcast failed");
    return { offered: 0 };
  }
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
    const { pool } = await dispatchPool(ctx, businessId);
    const eligible = await eligibleRiders(ctx, businessId, job.merchantId, body.riderIds, pool);
    // A rider holding an open offer for this job keeps it — re-broadcasting
    // must never stack a second open offer on them (auto-broadcast already
    // offered at creation, so a manual broadcast right after would
    // otherwise duplicate every card). Rebroadcast doesn't need this: it
    // withdraws open offers first.
    const alreadyOffered = new Set(
      (await ctx.prisma.jobOffer.findMany({ where: { jobId: job.id, status: "open", expiresAt: { gt: new Date() } }, select: { riderId: true } })).map((o) => o.riderId),
    );
    const fresh = eligible.filter((r) => !alreadyOffered.has(r.id));
    const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60_000);
    const offers = await createOffers(ctx, job.id, businessId, fresh, expiresAt);
    await ctx.audit.record(actorFor(req), "offer.broadcast", "job", job.id, { eligibleRiders: fresh.length, skippedAlreadyOffered: alreadyOffered.size, pool, expiresAt });
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
    const { pool } = await dispatchPool(ctx, businessId);
    const eligible = await eligibleRiders(ctx, businessId, job.merchantId, body.riderIds, pool);
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

  /**
   * Unclaimed work: every `new`, unassigned job the caller can see that
   * they do NOT already hold an open offer for — their own businesses'
   * plus, for marketplace-approved riders, any business whose pool is
   * open to free-roam. Jobs with a personal open offer live exclusively
   * in Available jobs (with the expiry countdown); showing them here too
   * would render two cards — and two Accept buttons — for one job.
   * Never leaks other businesses' jobs: the business set is derived from
   * the caller's own memberships + marketplace status, never a parameter.
   */
  app.get("/api/bearer/pending-jobs", { preHandler: ctx.requireRider }, async (req) => {
    await expire(ctx);
    const riderId = req.user!.riderId!;
    const rider = await ctx.prisma.rider.findUnique({ where: { id: riderId } });
    if (!rider || !rider.active) return { jobs: [] };
    const memberships = await ctx.prisma.riderMembership.findMany({ where: { riderId, status: "active" }, select: { businessId: true } });
    let businessIds = memberships.map((m) => m.businessId);
    if (rider.platformStatus === "approved") {
      const open = await ctx.prisma.business.findMany({ where: { active: true, courierPool: { not: "company" } }, select: { id: true } });
      businessIds = [...new Set([...businessIds, ...open.map((b) => b.id)])];
    }
    if (businessIds.length === 0) return { jobs: [] };
    const jobs = await ctx.prisma.job.findMany({
      where: { businessId: { in: businessIds }, status: "new", riderId: null, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: jobInclude,
    });
    const offeredJobIds = new Set(
      (await ctx.prisma.jobOffer.findMany({ where: { riderId, status: "open", jobId: { in: jobs.map((j) => j.id) } }, select: { jobId: true } })).map((o) => o.jobId),
    );
    const viewer = viewerFor(req);
    return { jobs: jobs.filter((j) => !offeredJobIds.has(j.id)).map((j) => jobToDto(j, viewer, ctx.config.APP_ORIGIN)) };
  });

  /**
   * Claim an unclaimed job straight from the pending list — same
   * conditional-claim transaction as offer-accept (single winner,
   * in-tx capacity check, idempotency-key replay), so a claim can never
   * double-book or silently over-capacity the rider.
   */
  app.post<{ Params: { id: string } }>("/api/bearer/pending-jobs/:id/claim", { preHandler: ctx.requireRider }, async (req, reply) => {
    const key = idempotencyKeyFrom(req);
    const { status, body } = await withIdempotency(ctx, req.user!.sub, key, async () => {
      await expire(ctx);
      const riderId = req.user!.riderId!;
      const actor = actorFor(req);
      const job = await ctx.prisma.job.findUnique({ where: { id: req.params.id } });
      if (!job || job.status !== "new" || job.riderId || job.deletedAt) throw httpErrors.createError(409, "This job is no longer available");
      const { pool } = await dispatchPool(ctx, job.businessId);
      // Visibility IS claimability here: an active member, or a
      // marketplace-approved rider facing an open pool. Anything else gets
      // the clearer 403 (rather than the membership 409 below, which can
      // no longer fire once visibility passes — kept as the guarantee).
      const rider = await ctx.prisma.rider.findUnique({ where: { id: riderId } });
      const visible =
        (await isActiveMember(ctx, riderId, job.businessId)) ||
        (!!rider?.active && rider.platformStatus === "approved" && pool !== "company");
      if (!visible) throw httpErrors.createError(403, "This job isn't in your pool");
      const via = await ensureClaimMembership(ctx, job.businessId, pool, riderId);
      const result = await ctx.prisma.$transaction(async (tx) =>
        claimJobTx(tx, ctx, {
          jobId: job.id,
          riderId,
          actor,
          note: "pending list claimed",
          meta: { source: "pending_claim", ...(via === "free_roam" ? { membership: "auto-created (free-roam claim)" } : {}) },
          assignmentReason: "pending list claimed",
        }),
      );
      const dtoJob = jobToDto(result.job, viewerFor(req), ctx.config.APP_ORIGIN);
      const eventDto = eventToDto(result.event);
      ctx.hub.broadcastMany([roomForDispatch(result.job.businessId), roomForRider(riderId)], { type: "job.assigned", payload: { job: dtoJob, riderId, source: "pending_claim" } });
      ctx.hub.broadcastMany([roomForJob(job.id), roomForDispatch(result.job.businessId)], { type: "job.state", payload: { job: dtoJob, event: eventDto } });
      await ctx.audit.record(actor, "job.claim", "job", job.id, { source: "pending_claim" });
      return { status: 200, body: { job: dtoJob } };
    });
    return reply.code(status).send(body);
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

  app.post<{ Params: { id: string } }>("/api/bearer/offers/:id/accept", { preHandler: ctx.requireRider }, async (req, reply) => {
    const key = idempotencyKeyFrom(req);
    const { status, body } = await withIdempotency(ctx, req.user!.sub, key, async () => {
      await expire(ctx);
      const riderId = req.user!.riderId!;
      const actor = actorFor(req);
      const offer = await ctx.prisma.jobOffer.findFirst({ where: { id: req.params.id, riderId, status: "open", expiresAt: { gt: new Date() } } });
      if (!offer) throw httpErrors.createError(409, "Offer is no longer available");
      // A membership can be suspended between the offer being sent and the
      // rider tapping Accept — re-check it's still active at accept time,
      // not just when the offer went out. Marketplace-approved riders in a
      // free-roam pool are covered by auto-membership instead.
      const { pool } = await dispatchPool(ctx, offer.businessId);
      const via = await ensureClaimMembership(ctx, offer.businessId, pool, riderId);
      const result = await ctx.prisma.$transaction(async (tx) =>
        claimJobTx(tx, ctx, {
          jobId: offer.jobId,
          riderId,
          actor,
          note: "offer accepted",
          meta: { offerId: offer.id, ...(via === "free_roam" ? { membership: "auto-created (free-roam accept)" } : {}) },
          assignmentReason: "offer accepted",
          acceptedOfferId: offer.id,
        }),
      );
      // Straight to `accepted` (not the intermediate `assigned`) — a rider who
      // just accepted an offer has already said yes; making them tap a second
      // "Accept job" button on the very next screen was the confusing
      // double-accept this flow used to force. A job a dispatcher assigns
      // *without* an offer still lands on `assigned` (see assignJob) and does
      // need that one rider confirmation — this is the only path that gets to
      // skip it, because the offer itself already was that confirmation.
      const job = jobToDto(result.job, viewerFor(req), ctx.config.APP_ORIGIN);
      const eventDto = eventToDto(result.event);
      const dispatchRoom = roomForDispatch(result.job.businessId);
      ctx.hub.broadcastMany([dispatchRoom, roomForRider(riderId)], { type: "job.assigned", payload: { job, riderId, source: "offer" } });
      ctx.hub.broadcastMany([roomForJob(job.id), dispatchRoom], { type: "job.state", payload: { job, event: eventDto } });
      await ctx.audit.record(actor, "offer.accept", "job", job.id, { offerId: req.params.id });
      return { status: 200, body: { job } };
    });
    return reply.code(status).send(body);
  });
}

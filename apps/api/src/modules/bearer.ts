import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { idempotencyKeyFrom, withIdempotency } from "../lib/idempotency.js";
import { ACTIVE_JOB_STATUSES, roomForDispatch } from "@ronmacrae/contracts";
import type { DispatchContactDto } from "@ronmacrae/contracts";
import { getBusinessSettings } from "./settings.js";
import { jobToDto, listJobs, recordRiderStage, transitionJob, TransitionBody, type Actor, type Viewer } from "./jobs/index.js";
import { listLogisticsRiderThread, sendLogisticsRiderMessage, SendPlatformMessageBody } from "./platform-messages.js";
import { currentJobIdFor, riderToDto } from "./riders.js";
import type { BearerMeDto } from "@ronmacrae/contracts";

function actorFor(req: FastifyRequest): Actor {
  return { id: req.user!.sub, name: req.user!.name, role: req.user!.role, riderId: req.user!.riderId };
}

function viewerFor(req: FastifyRequest): Viewer {
  return { role: req.user!.role, riderId: req.user!.riderId };
}

const RiderTransitionBody = TransitionBody.extend({
  /** Required when a rider confirms delivery; never persisted or returned. */
  pin: z.string().regex(/^\d{4,10}$/).optional(),
});

/** Rider-scoped API surface. Every job query is constrained by token.riderId. */
export async function bearerRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  // Stage D (spec: "show the courier their active business memberships
  // clearly") — every real, currently-active relationship this courier
  // has: which businesses they carry jobs for, which merchants' own
  // rosters they're on, and their Platform-Admin-controlled offer-
  // eligibility attachment (a separate concept — see BearerMeDto's own
  // doc comment). Nothing here is derived from a client-supplied id;
  // every row comes from this rider's own token.
  app.get("/api/bearer/me", { preHandler: ctx.requireRider }, async (req) => {
    const riderId = req.user!.riderId!;
    const rider = await ctx.prisma.rider.findUniqueOrThrow({
      where: { id: riderId },
      include: {
        homeZone: { select: { name: true } },
        attachedMerchant: { select: { id: true, name: true } },
        attachedLogisticsCompany: { select: { id: true, name: true } },
      },
    });
    const [memberships, merchantRiders] = await Promise.all([
      ctx.prisma.riderMembership.findMany({ where: { riderId, status: "active" }, include: { business: { select: { id: true, name: true } } } }),
      ctx.prisma.merchantRider.findMany({ where: { riderId, status: "active" }, include: { merchant: { select: { id: true, name: true, businessId: true } } } }),
    ]);
    const dto: BearerMeDto = {
      rider: riderToDto(rider, { currentJobId: await currentJobIdFor(ctx, riderId) }),
      businesses: memberships.map((m) => ({ businessId: m.businessId, businessName: m.business.name })),
      merchants: merchantRiders.map((m) => ({ merchantId: m.merchant.id, merchantName: m.merchant.name, businessId: m.merchant.businessId })),
      attachment: {
        type: rider.attachment,
        merchantId: rider.attachedMerchantId,
        merchantName: rider.attachedMerchant?.name ?? null,
        logisticsCompanyId: rider.attachedLogisticsCompanyId,
        logisticsCompanyName: rider.attachedLogisticsCompany?.name ?? null,
      },
    };
    return dto;
  });

  /**
   * Business directory for couriers who want more work: every active
   * business, each tagged with THIS rider's relationship to it
   * (active/pending/suspended/removed/none) — derived from their own
   * token, never a parameter. The list is names only (no staff, no
   * stats): enough to choose where to apply, nothing sensitive.
   */
  app.get("/api/bearer/businesses", { preHandler: ctx.requireRider }, async (req) => {
    const riderId = req.user!.riderId!;
    const [businesses, memberships] = await Promise.all([
      ctx.prisma.business.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      ctx.prisma.riderMembership.findMany({ where: { riderId }, select: { businessId: true, status: true } }),
    ]);
    const statusByBusiness = new Map(memberships.map((m) => [m.businessId, m.status]));
    return {
      businesses: businesses.map((b) => ({ businessId: b.id, businessName: b.name, myStatus: statusByBusiness.get(b.id) ?? "none" })),
    };
  });

  /**
   * Apply to deliver for a business: creates a `pending` membership the
   * business's own admin approves in Team → Pending applications
   * (POST /api/riders/:id/decide — unchanged). Re-applying after a
   * removal resets to pending; an active membership, a pending
   * application, or a suspension all refuse with an explaining 409
   * (a suspension is an admin decision — applying again must not
   * silently undo it).
   */
  app.post<{ Params: { id: string } }>("/api/bearer/businesses/:id/apply", { preHandler: ctx.requireRider, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const riderId = req.user!.riderId!;
    const business = await ctx.prisma.business.findUnique({ where: { id: req.params.id } });
    if (!business || !business.active) throw httpErrors.createError(404, "Business not found");
    const existing = await ctx.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId, businessId: business.id } } });
    if (existing?.status === "active") throw httpErrors.createError(409, "You're already delivering for this business");
    if (existing?.status === "pending") throw httpErrors.createError(409, "Your application is already waiting for their approval");
    if (existing?.status === "suspended") throw httpErrors.createError(409, "Your access was suspended — contact their dispatch instead of re-applying");
    if (existing) {
      await ctx.prisma.riderMembership.update({ where: { id: existing.id }, data: { status: "pending", approvedAt: null } });
    } else {
      await ctx.prisma.riderMembership.create({ data: { riderId, businessId: business.id, status: "pending" } });
    }
    await ctx.audit.record(actorFor(req), "rider.apply", "business", business.id);
    // Live ping so an open Team screen can show the application without a refresh.
    ctx.hub.broadcast(roomForDispatch(business.id), { type: "rider.application", payload: { riderId, businessId: business.id } });
    return { ok: true, status: "pending" as const };
  });

  /**
   * The courier's own open-network switch: "I'm available to carry for
   * any business on the network." Only the courier themselves (this
   * token's own rider row — never another rider's, never by business
   * staff) or the Platform Admin can flip it; free-roam offers still
   * need ultra-admin approval AND each business's pool opt-in on top.
   */
  app.post("/api/bearer/profile/open-network", { preHandler: ctx.requireRider }, async (req) => {
    const body = z.object({ open: z.boolean() }).parse(req.body);
    const rider = await ctx.prisma.rider.update({ where: { id: req.user!.riderId! }, data: { openNetwork: body.open } });
    await ctx.audit.record(actorFor(req), body.open ? "rider.open_network.on" : "rider.open_network.off", "rider", rider.id);
    return { ok: true, openNetwork: rider.openNetwork };
  });

  /**
   * Confirm pickup for several packages at ONE spot in a single tap: every
   * listed job must be this rider's, still `accepted`, and share the exact
   * same pickup address — anything else is an honest 400 naming the odd
   * ones out (confirm those separately). Each job runs the same
   * accepted → picked_up → in_transit chain as the single-tap flow
   * (including the confirmed pickup spot), and the response reports
   * per-job results: HTTP 200 when all landed, 207 with the failures
   * spelled out when only some did — never a silent half-batch.
   */
  app.post("/api/bearer/jobs/pickup-batch", { preHandler: ctx.requireRider }, async (req, reply) => {
    const body = z
      .object({
        jobIds: z.array(z.string().min(1)).min(1).max(20),
        pickupPoint: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }).optional().nullable(),
        note: z.string().max(300).optional().or(z.literal("")).nullable(),
      })
      .parse(req.body);
    const key = idempotencyKeyFrom(req);
    const { status, body: out } = await withIdempotency(ctx, req.user!.sub, key, async () => {
      const riderId = req.user!.riderId!;
      const actor = actorFor(req);
      const viewer = viewerFor(req);
      const uniqueIds = [...new Set(body.jobIds)];
      const rows = await ctx.prisma.job.findMany({ where: { id: { in: uniqueIds } } });
      if (rows.length !== uniqueIds.length) throw httpErrors.createError(404, "One of these jobs doesn't exist — refresh and try again");
      const foreign = rows.filter((j) => j.riderId !== riderId).map((j) => j.jobNumber ?? j.id.slice(0, 8));
      if (foreign.length > 0) throw httpErrors.createError(403, `Not yours to pick up: ${foreign.join(", ")}`);
      const notReady = rows.filter((j) => j.status !== "accepted").map((j) => j.jobNumber ?? j.id.slice(0, 8));
      if (notReady.length > 0) throw httpErrors.createError(409, `Already past pickup: ${notReady.join(", ")} — refresh and confirm the rest one by one`);
      const addresses = new Set(rows.map((j) => j.pickupAddressText ?? ""));
      if (addresses.size > 1) throw httpErrors.createError(400, "These jobs have different pickup spots — confirm each address separately");
      const results: { jobId: string; ok: boolean; error?: string }[] = [];
      for (const job of rows) {
        try {
          await transitionJob(ctx, job.id, { to: "picked_up", note: body.note || "batch pickup", pickupPoint: body.pickupPoint ?? null }, actor, viewer);
          await transitionJob(ctx, job.id, { to: "in_transit" }, actor, viewer);
          results.push({ jobId: job.id, ok: true });
        } catch (err) {
          // One job losing a race (claimed back, cancelled by dispatch)
          // must not undo the ones already collected — report it, keep going.
          results.push({ jobId: job.id, ok: false, error: err instanceof Error ? err.message : "Could not pick up" });
        }
      }
      await ctx.audit.record(actor, "job.pickup_batch", "rider", riderId, { jobIds: uniqueIds, picked: results.filter((r) => r.ok).length });
      const failed = results.filter((r) => !r.ok);
      return { status: failed.length > 0 ? 207 : 200, body: { results } };
    });
    return reply.code(status).send(out);
  });

  app.get("/api/bearer/jobs", { preHandler: ctx.requireRider }, async (req) => {
    const riderId = req.user!.riderId!;
    const jobs = await listJobs(ctx, { riderId, take: 100, sort: "scheduled" });
    return { jobs: jobs.map((job) => jobToDto(job, viewerFor(req), ctx.config.APP_ORIGIN)) };
  });

  /** "Contact dispatch" button (spec 5F) — only the owner-configured dispatch
   *  contact, never any individual staff member's own phone number. A rider
   *  can carry jobs from several businesses at once, so this always needs a
   *  jobId to know which business's contact to show — the response for job
   *  A must never be that of some other business the rider also works for. */
  app.get<{ Querystring: { jobId?: string } }>("/api/bearer/dispatch-contact", { preHandler: ctx.requireRider }, async (req) => {
    const jobId = req.query.jobId;
    if (!jobId) throw httpErrors.createError(400, "jobId is required");
    const job = await ctx.prisma.job.findFirst({ where: { id: jobId, riderId: req.user!.riderId! }, select: { businessId: true } });
    if (!job) throw httpErrors.createError(404, "Job not found");
    const business = await getBusinessSettings(ctx, job.businessId);
    const contact: DispatchContactDto = {
      businessName: business.businessName,
      dispatchPhone: business.dispatchPhone,
      dispatchWhatsApp: business.dispatchWhatsApp,
    };
    return contact;
  });

  // Fleet messaging with the rider's own attached logistics company (spec:
  // "logistics<->riders") — see platform-messages.ts and this rider's own
  // company-side equivalent in logistics-portal.ts. A freelance or
  // merchant-attached rider has no logistics company to message — 404,
  // same "don't confirm what doesn't apply" pattern used elsewhere.
  app.get("/api/bearer/logistics-messages", { preHandler: ctx.requireRider }, async (req) => {
    const rider = await ctx.prisma.rider.findUniqueOrThrow({ where: { id: req.user!.riderId! } });
    if (!rider.attachedLogisticsCompanyId) throw httpErrors.createError(404, "You're not attached to a logistics company");
    return listLogisticsRiderThread(ctx, rider.attachedLogisticsCompanyId, rider.id, "rider", rider.id, true);
  });

  app.post("/api/bearer/logistics-messages", { preHandler: ctx.requireRider }, async (req) => {
    const rider = await ctx.prisma.rider.findUniqueOrThrow({ where: { id: req.user!.riderId! } });
    if (!rider.attachedLogisticsCompanyId) throw httpErrors.createError(404, "You're not attached to a logistics company");
    const body = SendPlatformMessageBody.parse(req.body);
    await sendLogisticsRiderMessage(ctx, rider.attachedLogisticsCompanyId, rider.id, "rider", rider.id, rider.name, body.body);
    return listLogisticsRiderThread(ctx, rider.attachedLogisticsCompanyId, rider.id, "rider", rider.id, true);
  });

  app.post<{ Params: { id: string } }>("/api/bearer/jobs/:id/accept", { preHandler: ctx.requireRider }, async (req, reply) => {
    const key = idempotencyKeyFrom(req);
    const { status, body } = await withIdempotency(ctx, req.user!.sub, key, async () => {
      // Cash check before the transition — an unverified rider handed a
      // cash job by direct assignment can't launder it through accept.
      const assigned = await ctx.prisma.job.findUnique({ where: { id: req.params.id }, select: { id: true, jobNumber: true, paymentMethod: true } });
      if (assigned) {
        const { assertMayCarryCod } = await import("./offers.js");
        await assertMayCarryCod(ctx, req.user!.riderId!, assigned);
      }
      const job = await transitionJob(ctx, req.params.id, { to: "accepted" }, actorFor(req), viewerFor(req));
      await ctx.audit.record(actorFor(req), "job.accepted", "job", job.id);
      return { status: 200, body: { job } };
    });
    return reply.code(status).send(body);
  });

  app.post<{ Params: { id: string } }>("/api/bearer/jobs/:id/transition", { preHandler: ctx.requireRider }, async (req, reply) => {
    const body = RiderTransitionBody.parse(req.body);
    const actor = actorFor(req);
    const viewer = viewerFor(req);
    if (body.to === "delivered") {
      const row = await ctx.prisma.job.findUnique({ where: { id: req.params.id }, select: { riderId: true, pin: true } });
      if (!row) throw httpErrors.createError(404, "Job not found");
      if (row.riderId !== req.user!.riderId) throw httpErrors.createError(403, "Not your job");
      if (!body.pin || body.pin !== row.pin) throw httpErrors.createError(400, "A valid delivery PIN is required");
    }
    const key = idempotencyKeyFrom(req);
    const { status, body: out } = await withIdempotency(ctx, req.user!.sub, key, async () => {
      const job = await transitionJob(ctx, req.params.id, body, actor, viewer);
      await ctx.audit.record(actor, `job.${body.to}`, "job", job.id);
      return { status: 200, body: { job } };
    });
    return reply.code(status).send(out);
  });

  app.post<{ Params: { id: string } }>("/api/bearer/jobs/:id/stage", { preHandler: ctx.requireRider }, async (req) => {
    const body = z.object({ stage: z.enum(["heading_to_pickup", "at_pickup"]), note: z.string().max(300).optional().or(z.literal("")) }).parse(req.body);
    const actor = actorFor(req);
    const job = await recordRiderStage(ctx, req.params.id, body.stage, { note: body.note || null }, actor, viewerFor(req));
    await ctx.audit.record(actor, `job.stage.${body.stage}`, "job", job.id);
    return { job };
  });

  /**
   * Rider sets their own intended work order for their currently active jobs
   * (spec 5B — route queue). This is an explicit, all-at-once reordering, not
   * a partial patch: the submitted id list must be exactly the rider's
   * current active-job set (same jobs, any order) — never adds, removes, or
   * silently drops one, and the app never reorders this on its own.
   */
  app.post("/api/bearer/jobs/reorder", { preHandler: ctx.requireRider }, async (req) => {
    const body = z.object({ jobIds: z.array(z.string().min(1)).min(1).max(50) }).parse(req.body);
    const riderId = req.user!.riderId!;
    const active = await ctx.prisma.job.findMany({ where: { riderId, status: { in: [...ACTIVE_JOB_STATUSES] } }, select: { id: true } });
    const activeIds = new Set(active.map((j) => j.id));
    const submitted = new Set(body.jobIds);
    if (activeIds.size !== submitted.size || [...activeIds].some((id) => !submitted.has(id))) {
      throw httpErrors.createError(409, "The submitted job list doesn't match your current active jobs — reload and try again");
    }
    await ctx.prisma.$transaction(
      body.jobIds.map((jobId, i) => ctx.prisma.job.update({ where: { id: jobId, riderId }, data: { routeSeq: i } })),
    );
    await ctx.audit.record(actorFor(req), "job.route_reorder", "rider", riderId, { order: body.jobIds });
    const jobs = await listJobs(ctx, { riderId, take: 100, sort: "scheduled" });
    return { jobs: jobs.map((job) => jobToDto(job, viewerFor(req), ctx.config.APP_ORIGIN)) };
  });
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { ACTIVE_JOB_STATUSES } from "@ronmacrae/contracts";
import type { DispatchContactDto } from "@ronmacrae/contracts";
import { getBusinessSettings } from "./settings.js";
import { jobToDto, listJobs, recordRiderStage, transitionJob, TransitionBody, type Actor, type Viewer } from "./jobs/index.js";
import { listLogisticsRiderThread, sendLogisticsRiderMessage, SendPlatformMessageBody } from "./platform-messages.js";

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

  app.post<{ Params: { id: string } }>("/api/bearer/jobs/:id/accept", { preHandler: ctx.requireRider }, async (req) => {
    const job = await transitionJob(ctx, req.params.id, { to: "accepted" }, actorFor(req), viewerFor(req));
    await ctx.audit.record(actorFor(req), "job.accepted", "job", job.id);
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/bearer/jobs/:id/transition", { preHandler: ctx.requireRider }, async (req) => {
    const body = RiderTransitionBody.parse(req.body);
    const actor = actorFor(req);
    const viewer = viewerFor(req);
    if (body.to === "delivered") {
      const row = await ctx.prisma.job.findUnique({ where: { id: req.params.id }, select: { riderId: true, pin: true } });
      if (!row) throw httpErrors.createError(404, "Job not found");
      if (row.riderId !== req.user!.riderId) throw httpErrors.createError(403, "Not your job");
      if (!body.pin || body.pin !== row.pin) throw httpErrors.createError(400, "A valid delivery PIN is required");
    }
    const job = await transitionJob(ctx, req.params.id, body, actor, viewer);
    await ctx.audit.record(actor, `job.${body.to}`, "job", job.id);
    return { job };
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

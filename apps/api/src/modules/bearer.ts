import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { jobToDto, listJobs, recordRiderStage, transitionJob, TransitionBody, type Actor, type Viewer } from "./jobs/index.js";

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
}

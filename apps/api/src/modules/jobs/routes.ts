import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../../ctx.js";
import type { JobStatus } from "@ronmacrae/contracts";
import { JOB_STATUSES } from "@ronmacrae/contracts";
import { jobToDto, jobSummaryToDto, assertJobBusiness, type Actor } from "./dto.js";
import { AssignBody, assignJob, unassignJob } from "./assign.js";
import { CreateJobBody, UpdateJobBody, createJob, updateJob, viewerFor } from "./create.js";
import { getJobByNumber, getJobRow, listJobs, countJobs, returnJobFor, type JobListFilter } from "./repository.js";
import { CollectBody, recordCollection } from "./payment.js";
import { cancelJob, createReturnJob, transitionJob, TransitionBody } from "./transition.js";
import { createTrackingLink, jobEventHistory, revokeTrackingLinkByToken } from "./history.js";
import { proofRoutes } from "./proofs.js";
import { trashRoutes } from "./trash.js";

function actorFor(req: FastifyRequest): Actor {
  return {
    id: req.user?.sub ?? null,
    name: req.user?.name ?? null,
    role: req.user?.role ?? "anonymous",
    riderId: req.user?.riderId ?? null,
    businessId: req.user?.businessId ?? null,
  };
}

const JobListQuery = z.object({
  /** comma-separated statuses, e.g. "assigned,accepted" */
  status: z.string().max(120).optional(),
  source: z.string().max(40).optional(),
  riderId: z.string().optional(),
  customerId: z.string().optional(),
  search: z.string().max(80).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
  sort: z.enum(["newest", "oldest", "scheduled"]).default("newest"),
});

function parseStatuses(raw: string | undefined): JobStatus[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  for (const p of parts) {
    if (!(JOB_STATUSES as readonly string[]).includes(p)) {
      throw httpErrors.createError(400, `Unknown status "${p}"`);
    }
  }
  return parts as JobStatus[];
}

/**
 * Dispatcher-facing job management (plus shared proof + tracking-link routes).
 * Rider-facing endpoints live in the bearer module.
 */
export async function jobRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const staff = ctx.requireStaff("admin", "dispatcher", "accountant", "viewer");
  const writer = ctx.requireStaff("admin", "dispatcher");

  app.get("/api/jobs", { preHandler: staff }, async (req) => {
    const q = JobListQuery.parse(req.query);
    const filter: JobListFilter = {
      businessId: req.user!.businessId!,
      status: parseStatuses(q.status),
      source: q.source,
      riderId: q.riderId,
      customerId: q.customerId,
      search: q.search,
      from: q.from,
      to: q.to,
      take: q.take,
      skip: q.skip,
      sort: q.sort,
    };
    const [jobs, total] = await Promise.all([listJobs(ctx, filter), countJobs(ctx, filter)]);
    return { jobs: jobs.map(jobSummaryToDto), total };
  });

  app.post("/api/jobs", { preHandler: writer }, async (req) => {
    const body = CreateJobBody.parse(req.body);
    const job = await createJob(ctx, body, actorFor(req), viewerFor(req));
    await ctx.audit.record(actorFor(req), "job.create", "job", job.id, { jobNumber: job.jobNumber });
    return { job };
  });

  // resolve by id or job number (RM-000123)
  app.get<{ Params: { id: string } }>("/api/jobs/:id", { preHandler: ctx.requireAuth }, async (req) => {
    let row = await getJobRow(ctx, req.params.id);
    // Job numbers are only unique per business now — a rider (no fixed
    // session business) can't resolve one this way; they look up by id.
    if (!row && /^rm-/i.test(req.params.id) && req.user!.businessId) {
      row = await getJobByNumber(ctx, req.user!.businessId, req.params.id);
    }
    if (!row) throw httpErrors.createError(404, "Job not found");
    if (req.user!.role === "rider" && row.riderId !== req.user!.riderId) {
      throw httpErrors.createError(403, "Not your job");
    }
    assertJobBusiness({ role: req.user!.role, businessId: req.user!.businessId }, row.businessId);
    const returnJobId = await returnJobFor(ctx, row.id);
    return { job: jobToDto(row, viewerFor(req), ctx.config.APP_ORIGIN, { returnJobId }) };
  });

  app.patch<{ Params: { id: string } }>("/api/jobs/:id", { preHandler: writer }, async (req) => {
    const body = UpdateJobBody.parse(req.body);
    const job = await updateJob(ctx, req.params.id, body, actorFor(req), viewerFor(req));
    await ctx.audit.record(actorFor(req), "job.update", "job", job.id);
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/transition", { preHandler: writer }, async (req) => {
    const body = TransitionBody.parse(req.body);
    const job = await transitionJob(
      ctx,
      req.params.id,
      {
        to: body.to,
        note: body.note || null,
        failureReason: body.failureReason,
        failureNote: body.failureNote || null,
        point: body.point,
        addressText: body.addressText,
        landmark: body.landmark,
        stage: body.stage,
        amountCollected: body.amountCollected,
      },
      actorFor(req),
      viewerFor(req),
    );
    await ctx.audit.record(actorFor(req), `job.${body.to}`, "job", job.id);
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/assignments", { preHandler: writer }, async (req) => {
    const body = AssignBody.parse(req.body);
    const job = await assignJob(ctx, req.params.id, { riderId: body.riderId, reason: body.reason || null }, actorFor(req), viewerFor(req));
    await ctx.audit.record(actorFor(req), "job.assign", "job", job.id, { riderId: body.riderId });
    return { job };
  });

  app.delete<{ Params: { id: string } }>("/api/jobs/:id/assignments", { preHandler: writer }, async (req) => {
    const body = z.object({ reason: z.string().max(200).optional().or(z.literal("")).nullable().default("") }).parse(req.body ?? {});
    const job = await unassignJob(ctx, req.params.id, actorFor(req), viewerFor(req), body.reason || null);
    await ctx.audit.record(actorFor(req), "job.unassign", "job", job.id);
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", { preHandler: writer }, async (req) => {
    const body = z.object({ note: z.string().max(300).optional().or(z.literal("")).nullable().default("") }).parse(req.body ?? {});
    const job = await cancelJob(ctx, req.params.id, actorFor(req), viewerFor(req), body.note || null);
    await ctx.audit.record(actorFor(req), "job.cancel", "job", job.id);
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/return", { preHandler: writer }, async (req) => {
    const job = await createReturnJob(ctx, req.params.id, actorFor(req), viewerFor(req));
    await ctx.audit.record(actorFor(req), "job.return", "job", job.id, { returnJobId: job.id });
    return { job };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/collect", { preHandler: ctx.requireAuth }, async (req) => {
    const body = CollectBody.parse(req.body ?? {});
    const job = await recordCollection(ctx, req.params.id, body, actorFor(req), viewerFor(req));
    await ctx.audit.record(actorFor(req), "job.collect", "job", job.id);
    return { job };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/events", { preHandler: staff }, async (req) => {
    return { events: await jobEventHistory(ctx, req.params.id, viewerFor(req)) };
  });

  // customer tracking link for a job (dispatcher shares it)
  app.post<{ Params: { id: string } }>("/api/jobs/:id/tracking-link", { preHandler: writer }, async (req) => {
    const link = await createTrackingLink(ctx, req.params.id, viewerFor(req));
    await ctx.audit.record(actorFor(req), "job.tracking_link", "job", req.params.id);
    return { link };
  });

  app.post<{ Params: { token: string } }>("/api/jobs/tracking/:token/revoke", { preHandler: writer }, async (req) => {
    const link = await revokeTrackingLinkByToken(ctx, req.params.token, viewerFor(req));
    await ctx.audit.record(actorFor(req), "job.tracking_revoke", "trackingLink", link.id);
    return { link };
  });

  await proofRoutes(app, ctx);
  await trashRoutes(app, ctx);
}

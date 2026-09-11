import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { TERMINAL_JOB_STATUSES, ROOM_DISPATCH, roomForJob } from "@ronmacrae/contracts";
import type { AddressChangeRequestDto, DeliveryMessageDto, DeliveryMessagesDto, MessageSenderRole } from "@ronmacrae/contracts";

const MAX_MESSAGE_LENGTH = 1000;
/** Abuse protection: a burst cap per job per sending role, not a hard global
 *  limit — a busy conversation between three real people over a live
 *  delivery is still well under this in normal use. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 15;

const SenderRoleLabel: Record<MessageSenderRole, string> = {
  customer: "Customer",
  rider: "Rider",
  dispatcher: "Dispatch",
  system: "System",
};

interface ViewerIdentity {
  role: MessageSenderRole;
  /** User.id for dispatcher, Rider.id for rider, null for customer/system */
  id: string | null;
}

function messageToDto(
  row: { id: string; jobId: string; senderRole: string; senderId: string | null; body: string; readByCustomer: boolean; readByRider: boolean; readByStaff: boolean; createdAt: Date },
  viewer: ViewerIdentity,
): DeliveryMessageDto {
  const senderRole = row.senderRole as MessageSenderRole;
  // For dispatcher/rider, a job can change hands (reassignment, a different
  // staff member responding) — compare the actual sender id, not just the
  // role, so an old message from a previous rider/staff member never shows
  // as "You" to whoever has the job now. Customer has no stored senderId
  // (there's only ever one customer per job), so role alone is unambiguous.
  const isSelf =
    senderRole === viewer.role && (senderRole === "customer" || senderRole === "system" ? true : row.senderId === viewer.id);
  const read = viewer.role === "customer" ? row.readByCustomer : viewer.role === "rider" ? row.readByRider : true;
  return {
    id: row.id,
    jobId: row.jobId,
    senderRole,
    isSelf,
    senderName: isSelf ? "You" : SenderRoleLabel[senderRole],
    body: row.body,
    read,
    createdAt: row.createdAt.toISOString(),
  };
}

function addressChangeToDto(row: {
  id: string;
  jobId: string;
  requestedByRole: string;
  proposedAddressText: string;
  note: string | null;
  status: string;
  reviewedBy: { name: string } | null;
  reviewedAt: Date | null;
  createdAt: Date;
}): AddressChangeRequestDto {
  return {
    id: row.id,
    jobId: row.jobId,
    requestedByRole: row.requestedByRole as MessageSenderRole,
    proposedAddressText: row.proposedAddressText,
    note: row.note,
    status: row.status as AddressChangeRequestDto["status"],
    reviewedByName: row.reviewedBy?.name ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const SendBody = z.object({ body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) });
const AddressChangeBody = z.object({ proposedAddressText: z.string().trim().min(1).max(300), note: z.string().max(300).optional().or(z.literal("")).nullable() });

async function assertNotRateLimited(ctx: AppCtx, jobId: string, senderRole: MessageSenderRole): Promise<void> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const count = await ctx.prisma.deliveryMessage.count({ where: { jobId, senderRole, createdAt: { gte: since } } });
  if (count >= RATE_LIMIT_MAX) {
    throw httpErrors.createError(429, "Too many messages sent recently — please wait a moment before sending another.");
  }
}

async function loadJobForMessaging(ctx: AppCtx, jobId: string) {
  const job = await ctx.prisma.job.findUnique({ where: { id: jobId }, select: { id: true, status: true, riderId: true, addressText: true } });
  if (!job) throw httpErrors.createError(404, "Job not found");
  return job;
}

async function sendMessage(
  ctx: AppCtx,
  jobId: string,
  senderRole: MessageSenderRole,
  senderId: string | null,
  body: string,
): Promise<{ id: string; jobId: string; senderRole: string; senderId: string | null; body: string; readByCustomer: boolean; readByRider: boolean; readByStaff: boolean; createdAt: Date }> {
  await assertNotRateLimited(ctx, jobId, senderRole);
  const row = await ctx.prisma.deliveryMessage.create({
    data: {
      jobId,
      senderRole,
      senderId,
      body,
      readByCustomer: senderRole === "customer",
      readByRider: senderRole === "rider",
      readByStaff: senderRole === "dispatcher" || senderRole === "system",
    },
  });
  ctx.hub.broadcastMany([ROOM_DISPATCH, roomForJob(jobId)], {
    type: "delivery_message",
    payload: { jobId, id: row.id, senderRole },
  });
  return row;
}

/** GET a job's conversation for one viewer, marking everyone else's messages
 *  as read by that viewer along the way. */
async function listMessages(ctx: AppCtx, jobId: string, viewer: ViewerIdentity, open: boolean): Promise<DeliveryMessagesDto> {
  const job = await ctx.prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!job) throw httpErrors.createError(404, "Job not found");
  const rows = await ctx.prisma.deliveryMessage.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  const readField = viewer.role === "customer" ? "readByCustomer" : viewer.role === "rider" ? "readByRider" : viewer.role === "dispatcher" ? "readByStaff" : null;
  if (readField) {
    const unreadIds = rows.filter((r) => !r[readField] && r.senderRole !== viewer.role).map((r) => r.id);
    if (unreadIds.length > 0) {
      await ctx.prisma.deliveryMessage.updateMany({ where: { id: { in: unreadIds } }, data: { [readField]: true } });
    }
  }
  return {
    jobId,
    jobStatus: job.status,
    open,
    messages: rows.map((r) => messageToDto(r, viewer)),
  };
}

export async function deliveryMessageRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const staffRead = ctx.requireStaff("admin", "dispatcher", "accountant", "viewer");
  const staffWrite = ctx.requireStaff("admin", "dispatcher");

  // ---------------------------------------------------------------------
  // Customer side — gated entirely by the tracking token, never a login.
  // ---------------------------------------------------------------------
  async function resolveCustomerLink(token: string): Promise<{ jobId: string; open: boolean }> {
    const link = await ctx.prisma.trackingLink.findUnique({ where: { token } });
    if (!link) throw httpErrors.createError(410, "This tracking link is no longer valid");
    if (link.revoked) throw httpErrors.createError(410, "This tracking link has been revoked");
    const job = await ctx.prisma.job.findUnique({ where: { id: link.jobId }, select: { status: true } });
    if (!job) throw httpErrors.createError(410, "This tracking link is no longer valid");
    const linkOpen = link.expiresAt > new Date();
    const jobOpen = !TERMINAL_JOB_STATUSES.includes(job.status);
    return { jobId: link.jobId, open: linkOpen && jobOpen };
  }

  app.get<{ Params: { token: string } }>("/api/tracking/:token/messages", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { jobId, open } = await resolveCustomerLink(req.params.token);
    return listMessages(ctx, jobId, { role: "customer", id: null }, open);
  });

  app.post<{ Params: { token: string } }>("/api/tracking/:token/messages", async (req) => {
    const { jobId, open } = await resolveCustomerLink(req.params.token);
    if (!open) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const body = SendBody.parse(req.body);
    await sendMessage(ctx, jobId, "customer", null, body.body);
    return listMessages(ctx, jobId, { role: "customer", id: null }, open);
  });

  app.post<{ Params: { token: string } }>("/api/tracking/:token/address-change", async (req) => {
    const { jobId, open } = await resolveCustomerLink(req.params.token);
    if (!open) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const body = AddressChangeBody.parse(req.body);
    const request = await ctx.prisma.addressChangeRequest.create({
      data: { jobId, requestedByRole: "customer", proposedAddressText: body.proposedAddressText, note: body.note || null },
    });
    await sendMessage(ctx, jobId, "system", null, `Customer requested a new delivery address: "${body.proposedAddressText}". Waiting for dispatch to confirm.`);
    await ctx.audit.record({ id: null, role: "customer" }, "address_change.request", "job", jobId, { requestId: request.id });
    return addressChangeToDto({ ...request, reviewedBy: null });
  });

  // ---------------------------------------------------------------------
  // Staff side — monitor (all 4 staff roles) / respond+resolve (admin/dispatcher)
  // ---------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/jobs/:id/messages", { preHandler: staffRead }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    return listMessages(ctx, req.params.id, { role: "dispatcher", id: req.user!.sub }, !TERMINAL_JOB_STATUSES.includes(job.status));
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/messages", { preHandler: staffWrite }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const body = SendBody.parse(req.body);
    await sendMessage(ctx, req.params.id, "dispatcher", req.user!.sub, body.body);
    return listMessages(ctx, req.params.id, { role: "dispatcher", id: req.user!.sub }, true);
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/address-change-requests", { preHandler: staffRead }, async (req) => {
    await loadJobForMessaging(ctx, req.params.id);
    const rows = await ctx.prisma.addressChangeRequest.findMany({
      where: { jobId: req.params.id },
      include: { reviewedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    return { requests: rows.map(addressChangeToDto) };
  });

  app.post<{ Params: { id: string; reqId: string } }>("/api/jobs/:id/address-change-requests/:reqId/approve", { preHandler: staffWrite }, async (req) => {
    const request = await ctx.prisma.addressChangeRequest.findUnique({ where: { id: req.params.reqId } });
    if (!request || request.jobId !== req.params.id) throw httpErrors.createError(404, "Address change request not found");
    if (request.status !== "pending") throw httpErrors.createError(409, "This request has already been reviewed");
    const job = await ctx.prisma.job.findUniqueOrThrow({ where: { id: req.params.id } });

    const updated = await ctx.prisma.$transaction(async (tx) => {
      await tx.job.update({ where: { id: req.params.id }, data: { addressText: request.proposedAddressText } });
      await tx.jobEvent.create({
        data: {
          jobId: req.params.id,
          from: job.status,
          to: job.status,
          actorType: "dispatcher",
          actorId: req.user!.sub,
          actorName: req.user!.name,
          note: `Address changed (customer request approved): "${job.addressText ?? "(none)"}" -> "${request.proposedAddressText}"`,
          meta: { addressChangeRequestId: request.id, previousAddressText: job.addressText } as object,
        },
      });
      return tx.addressChangeRequest.update({
        where: { id: request.id },
        data: { status: "approved", reviewedById: req.user!.sub, reviewedAt: new Date() },
        include: { reviewedBy: { select: { name: true } } },
      });
    });
    await sendMessage(ctx, req.params.id, "system", null, `Dispatch confirmed the new delivery address: "${request.proposedAddressText}".`);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "address_change.approve", "job", req.params.id, { requestId: request.id });
    return addressChangeToDto(updated);
  });

  app.post<{ Params: { id: string; reqId: string } }>("/api/jobs/:id/address-change-requests/:reqId/decline", { preHandler: staffWrite }, async (req) => {
    const body = z.object({ note: z.string().max(300).optional().or(z.literal("")) }).parse(req.body ?? {});
    const request = await ctx.prisma.addressChangeRequest.findUnique({ where: { id: req.params.reqId } });
    if (!request || request.jobId !== req.params.id) throw httpErrors.createError(404, "Address change request not found");
    if (request.status !== "pending") throw httpErrors.createError(409, "This request has already been reviewed");
    const updated = await ctx.prisma.addressChangeRequest.update({
      where: { id: request.id },
      data: { status: "declined", reviewedById: req.user!.sub, reviewedAt: new Date(), note: body.note || request.note },
      include: { reviewedBy: { select: { name: true } } },
    });
    await sendMessage(ctx, req.params.id, "system", null, "Dispatch did not confirm the requested address change. The delivery address is unchanged.");
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "address_change.decline", "job", req.params.id, { requestId: request.id });
    return addressChangeToDto(updated);
  });

  // ---------------------------------------------------------------------
  // Rider side — only the rider actually assigned to the job.
  // ---------------------------------------------------------------------
  function assertOwnJob(req: FastifyRequest, job: { riderId: string | null }): void {
    if (job.riderId !== req.user!.riderId) throw httpErrors.createError(403, "Not your job");
  }

  app.get<{ Params: { id: string } }>("/api/bearer/jobs/:id/messages", { preHandler: ctx.requireRider }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertOwnJob(req, job);
    return listMessages(ctx, req.params.id, { role: "rider", id: req.user!.riderId! }, !TERMINAL_JOB_STATUSES.includes(job.status));
  });

  app.post<{ Params: { id: string } }>("/api/bearer/jobs/:id/messages", { preHandler: ctx.requireRider }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertOwnJob(req, job);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const body = SendBody.parse(req.body);
    await sendMessage(ctx, req.params.id, "rider", req.user!.riderId!, body.body);
    return listMessages(ctx, req.params.id, { role: "rider", id: req.user!.riderId! }, true);
  });

  app.post<{ Params: { id: string } }>("/api/bearer/jobs/:id/address-change", { preHandler: ctx.requireRider }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertOwnJob(req, job);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const body = AddressChangeBody.parse(req.body);
    const request = await ctx.prisma.addressChangeRequest.create({
      data: { jobId: req.params.id, requestedByRole: "rider", proposedAddressText: body.proposedAddressText, note: body.note || null },
    });
    await sendMessage(ctx, req.params.id, "system", null, `Rider requested a new delivery address: "${body.proposedAddressText}". Waiting for dispatch to confirm.`);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "address_change.request", "job", req.params.id, { requestId: request.id });
    return addressChangeToDto({ ...request, reviewedBy: null });
  });
}

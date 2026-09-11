import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { TERMINAL_JOB_STATUSES, roomForDispatch, roomForJob } from "@ronmacrae/contracts";
import type {
  AddressChangeRequestDto,
  ConversationKind,
  ConversationSummaryDto,
  ConversationsDto,
  DeliveryMessageDto,
  DeliveryMessagesDto,
  MessageSenderRole,
} from "@ronmacrae/contracts";
import { CONVERSATION_KINDS } from "@ronmacrae/contracts";

const MAX_MESSAGE_LENGTH = 1000;
/** Abuse protection: a burst cap per job+conversation+sending role, not a
 *  hard global limit — a busy exchange between two real people over a live
 *  delivery is still well under this in normal use. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 15;

const SenderRoleLabel: Record<MessageSenderRole, string> = {
  customer: "Customer",
  rider: "Rider",
  dispatcher: "Dispatch",
  system: "System",
};

/** Viewer's own role in the *messaging* sense: which side of a
 *  conversation they're on. Staff always messages as "dispatcher" here
 *  regardless of their actual admin/dispatcher/accountant/viewer role. */
type MessagingRole = "customer" | "rider" | "dispatcher";

interface ViewerIdentity {
  role: MessagingRole;
  /** User.id for dispatcher, Rider.id for rider, null for customer */
  id: string | null;
}

/** Which conversations each side may read/write. Staff may additionally
 *  *read* customer_rider (monitor-only — see canWriteKinds) even though
 *  they're never a party to it. */
const PARTY_KINDS: Record<MessagingRole, ConversationKind[]> = {
  customer: ["customer_dispatch", "customer_rider"],
  rider: ["customer_rider", "rider_dispatch"],
  dispatcher: ["customer_dispatch", "rider_dispatch"],
};
const STAFF_MONITOR_KINDS: ConversationKind[] = ["customer_dispatch", "customer_rider", "rider_dispatch"];

function assertKind(kind: string): ConversationKind {
  if (!(CONVERSATION_KINDS as readonly string[]).includes(kind)) {
    throw httpErrors.createError(404, "Unknown conversation");
  }
  return kind as ConversationKind;
}

function readableKinds(viewer: ViewerIdentity): ConversationKind[] {
  return viewer.role === "dispatcher" ? STAFF_MONITOR_KINDS : PARTY_KINDS[viewer.role];
}

function assertReadable(viewer: ViewerIdentity, kind: ConversationKind): void {
  if (!readableKinds(viewer).includes(kind)) throw httpErrors.createError(404, "Unknown conversation");
}

function assertWritable(viewer: ViewerIdentity, kind: ConversationKind): void {
  if (!PARTY_KINDS[viewer.role].includes(kind)) {
    throw httpErrors.createError(403, "You can only send messages in a conversation you're a party to");
  }
}

type MessageRow = {
  id: string;
  jobId: string;
  conversationKind: string | null;
  senderRole: string;
  senderId: string | null;
  body: string;
  deliveredAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
};

function messageToDto(row: MessageRow, viewer: ViewerIdentity): DeliveryMessageDto {
  const senderRole = row.senderRole as MessageSenderRole;
  // For dispatcher/rider, a job can change hands (reassignment, a different
  // staff member responding) — compare the actual sender id, not just the
  // role, so an old message from a previous rider/staff member never shows
  // as "You" to whoever has the job now. Customer has no stored senderId
  // (there's only ever one customer per job), so role alone is unambiguous.
  // A "system" message is never anyone's own — viewer.role is never
  // "system" (see MessagingRole).
  const isSelf = senderRole === viewer.role && (senderRole === "customer" ? true : row.senderId === viewer.id);
  return {
    id: row.id,
    jobId: row.jobId,
    conversationKind: (row.conversationKind as ConversationKind | null) ?? null,
    senderRole,
    isSelf,
    senderName: isSelf ? "You" : SenderRoleLabel[senderRole],
    body: row.body,
    delivered: row.deliveredAt !== null,
    read: row.readAt !== null,
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

const SendBody = z.object({ body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH), clientToken: z.string().max(100).optional() });
const AddressChangeBody = z.object({ proposedAddressText: z.string().trim().min(1).max(300), note: z.string().max(300).optional().or(z.literal("")).nullable() });

async function assertNotRateLimited(ctx: AppCtx, jobId: string, kind: ConversationKind, senderRole: MessageSenderRole): Promise<void> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const count = await ctx.prisma.deliveryMessage.count({ where: { jobId, conversationKind: kind, senderRole, createdAt: { gte: since } } });
  if (count >= RATE_LIMIT_MAX) {
    throw httpErrors.createError(429, "Too many messages sent recently — please wait a moment before sending another.");
  }
}

async function loadJobForMessaging(ctx: AppCtx, jobId: string) {
  // A trashed job (Stage 26) closes messaging entirely, for every side —
  // restoring it reopens exactly what was there before, untouched.
  const job = await ctx.prisma.job.findUnique({ where: { id: jobId, deletedAt: null }, select: { id: true, status: true, riderId: true, addressText: true, businessId: true } });
  if (!job) throw httpErrors.createError(404, "Job not found");
  return job;
}

/** Staff access to a job's conversation is scoped exactly like every other
 *  job resource — a business only ever sees/writes to its own jobs' chats,
 *  never another business's, even one sharing the same rider. */
function assertMessagingBusiness(actorOrViewer: { role: string; businessId?: string | null }, jobBusinessId: string): void {
  if (actorOrViewer.role === "rider" || actorOrViewer.role === "customer") return;
  if (!actorOrViewer.businessId || actorOrViewer.businessId !== jobBusinessId) {
    throw httpErrors.createError(404, "Job not found");
  }
}

/** A live realtime socket connected right now for the *other* side of a
 *  conversation, if any — used only to decide whether a fresh message can
 *  honestly be marked "delivered" immediately (see DeliveryMessageDto's
 *  own doc comment on why customers never get this: they have no live
 *  channel in this app, poll-only). */
function recipientHasLiveSocket(ctx: AppCtx, kind: ConversationKind, senderRole: MessageSenderRole, riderId: string | null): boolean {
  if (senderRole === "customer" || senderRole === "system") return false; // recipient side has no socket concept here
  if (kind === "customer_rider") return false; // the recipient is the customer (poll-only) or, if rider sent it, also the customer
  // customer_dispatch: recipient is staff (dispatch room presence, not tracked per-client here — treated as "not verifiable live", conservative)
  // rider_dispatch: recipient is whichever side didn't send it
  if (kind === "rider_dispatch" && senderRole === "dispatcher" && riderId) {
    return Boolean(ctx.hub.clientForRider(riderId));
  }
  return false;
}

async function sendMessage(
  ctx: AppCtx,
  jobId: string,
  businessId: string,
  kind: ConversationKind,
  senderRole: MessageSenderRole,
  senderId: string | null,
  body: string,
  riderId: string | null,
  clientToken?: string,
): Promise<MessageRow> {
  if (clientToken) {
    const existing = await ctx.prisma.deliveryMessage.findUnique({
      where: { jobId_conversationKind_clientToken: { jobId, conversationKind: kind, clientToken } },
    });
    if (existing) return existing; // retry of an already-sent message — never a duplicate
  }
  await assertNotRateLimited(ctx, jobId, kind, senderRole);
  const deliveredNow = recipientHasLiveSocket(ctx, kind, senderRole, riderId);
  const row = await ctx.prisma.deliveryMessage.create({
    data: {
      jobId,
      conversationKind: kind,
      senderRole,
      senderId,
      body,
      deliveredAt: deliveredNow ? new Date() : null,
      clientToken: clientToken || null,
    },
  });
  ctx.hub.broadcastMany([roomForDispatch(businessId), roomForJob(jobId)], {
    type: "delivery_message",
    payload: { jobId, id: row.id, conversationKind: kind, senderRole },
  });
  return row;
}

/** Fans a system announcement (an address-change decision) out to every
 *  conversation it's actually relevant to: the customer always needs to
 *  know (customer_dispatch), and the rider does too, for navigation, if
 *  one is currently assigned (rider_dispatch). Never customer_rider —
 *  that's not the confirmed-operational-change channel. */
async function sendSystemMessage(ctx: AppCtx, jobId: string, businessId: string, riderId: string | null, body: string): Promise<void> {
  const kinds: ConversationKind[] = riderId ? ["customer_dispatch", "rider_dispatch"] : ["customer_dispatch"];
  for (const kind of kinds) {
    await ctx.prisma.deliveryMessage.create({ data: { jobId, conversationKind: kind, senderRole: "system", body } });
  }
  ctx.hub.broadcastMany([roomForDispatch(businessId), roomForJob(jobId)], { type: "delivery_message", payload: { jobId, senderRole: "system" } });
}

/** GET one conversation for one viewer. `marksRead` is false for staff
 *  monitoring customer_rider — they aren't a party to it, so their
 *  viewing it must never register as "the other side has read this" (that
 *  concept only applies between the conversation's own two sides). */
async function listMessages(ctx: AppCtx, jobId: string, kind: ConversationKind, viewer: ViewerIdentity, open: boolean, marksRead: boolean): Promise<DeliveryMessagesDto> {
  const job = await ctx.prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!job) throw httpErrors.createError(404, "Job not found");
  const rows = await ctx.prisma.deliveryMessage.findMany({ where: { jobId, conversationKind: kind }, orderBy: { createdAt: "asc" } });
  if (marksRead) {
    const now = new Date();
    const unreadIds = rows.filter((r) => r.senderRole !== viewer.role && r.readAt === null).map((r) => r.id);
    if (unreadIds.length > 0) {
      await ctx.prisma.deliveryMessage.updateMany({ where: { id: { in: unreadIds } }, data: { readAt: now, deliveredAt: now } });
      for (const r of rows) if (unreadIds.includes(r.id)) { r.readAt = now; r.deliveredAt = now; }
    }
  }
  return {
    jobId,
    jobStatus: job.status,
    open,
    conversationKind: kind,
    messages: rows.map((r) => messageToDto(r, viewer)),
  };
}

/** GET the pre-Stage-24 shared-thread archive — read-only, no new
 *  messages ever land here again. Visible to everyone who could see the
 *  old shared thread (customer, the assigned rider, staff). */
async function listLegacyMessages(ctx: AppCtx, jobId: string, viewer: ViewerIdentity, open: boolean): Promise<DeliveryMessagesDto> {
  const job = await ctx.prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!job) throw httpErrors.createError(404, "Job not found");
  const rows = await ctx.prisma.deliveryMessage.findMany({ where: { jobId, conversationKind: null }, orderBy: { createdAt: "asc" } });
  return { jobId, jobStatus: job.status, open, conversationKind: null, messages: rows.map((r) => messageToDto(r, viewer)) };
}

async function conversationsSummary(ctx: AppCtx, jobId: string, viewer: ViewerIdentity): Promise<ConversationsDto> {
  const kinds = readableKinds(viewer);
  const writable = new Set(PARTY_KINDS[viewer.role]);
  const conversations: ConversationSummaryDto[] = [];
  for (const kind of kinds) {
    const [unreadCount, last] = await Promise.all([
      ctx.prisma.deliveryMessage.count({ where: { jobId, conversationKind: kind, senderRole: { not: viewer.role }, readAt: null } }),
      ctx.prisma.deliveryMessage.findFirst({ where: { jobId, conversationKind: kind }, orderBy: { createdAt: "desc" } }),
    ]);
    conversations.push({
      kind,
      canWrite: writable.has(kind),
      // A monitor (staff on customer_rider) never registers an "unread"
      // badge for a conversation they aren't a party to.
      unreadCount: writable.has(kind) ? unreadCount : 0,
      lastMessage: last ? { body: last.body, senderRole: last.senderRole as MessageSenderRole, createdAt: last.createdAt.toISOString() } : null,
    });
  }
  return { jobId, conversations };
}

export async function deliveryMessageRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const staffRead = ctx.requireStaff("admin", "dispatcher", "accountant", "viewer");
  const staffWrite = ctx.requireStaff("admin", "dispatcher");

  // ---------------------------------------------------------------------
  // Customer side — gated entirely by the tracking token, never a login.
  // ---------------------------------------------------------------------
  async function resolveCustomerLink(token: string): Promise<{ jobId: string; businessId: string; riderId: string | null; open: boolean }> {
    const link = await ctx.prisma.trackingLink.findUnique({ where: { token } });
    if (!link) throw httpErrors.createError(410, "This tracking link is no longer valid");
    if (link.revoked) throw httpErrors.createError(410, "This tracking link has been revoked");
    // Same "no longer valid" response for a trashed job as any other
    // unreachable link — see tracking.ts's matching comment.
    const job = await ctx.prisma.job.findUnique({ where: { id: link.jobId, deletedAt: null }, select: { status: true, businessId: true, riderId: true } });
    if (!job) throw httpErrors.createError(410, "This tracking link is no longer valid");
    const linkOpen = link.expiresAt > new Date();
    const jobOpen = !TERMINAL_JOB_STATUSES.includes(job.status);
    return { jobId: link.jobId, businessId: job.businessId, riderId: job.riderId, open: linkOpen && jobOpen };
  }

  app.get<{ Params: { token: string; kind: string } }>("/api/tracking/:token/messages/:kind", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { jobId, open } = await resolveCustomerLink(req.params.token);
    const viewer: ViewerIdentity = { role: "customer", id: null };
    if (req.params.kind === "legacy") return listLegacyMessages(ctx, jobId, viewer, open);
    const kind = assertKind(req.params.kind);
    assertReadable(viewer, kind);
    return listMessages(ctx, jobId, kind, viewer, open, true);
  });

  app.post<{ Params: { token: string; kind: string } }>("/api/tracking/:token/messages/:kind", async (req) => {
    const { jobId, businessId, riderId, open } = await resolveCustomerLink(req.params.token);
    if (!open) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const viewer: ViewerIdentity = { role: "customer", id: null };
    const kind = assertKind(req.params.kind);
    assertWritable(viewer, kind);
    const body = SendBody.parse(req.body);
    await sendMessage(ctx, jobId, businessId, kind, "customer", null, body.body, riderId, body.clientToken);
    return listMessages(ctx, jobId, kind, viewer, open, true);
  });

  app.get<{ Params: { token: string } }>("/api/tracking/:token/conversations", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { jobId } = await resolveCustomerLink(req.params.token);
    return conversationsSummary(ctx, jobId, { role: "customer", id: null });
  });

  app.post<{ Params: { token: string } }>("/api/tracking/:token/address-change", async (req) => {
    const { jobId, businessId, riderId, open } = await resolveCustomerLink(req.params.token);
    if (!open) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const body = AddressChangeBody.parse(req.body);
    const request = await ctx.prisma.addressChangeRequest.create({
      data: { jobId, requestedByRole: "customer", proposedAddressText: body.proposedAddressText, note: body.note || null },
    });
    await sendSystemMessage(ctx, jobId, businessId, riderId, `Customer requested a new delivery address: "${body.proposedAddressText}". Waiting for dispatch to confirm.`);
    await ctx.audit.record({ id: null, role: "customer" }, "address_change.request", "job", jobId, { requestId: request.id });
    return addressChangeToDto({ ...request, reviewedBy: null });
  });

  // ---------------------------------------------------------------------
  // Staff side — monitor (all 4 staff roles) / respond+resolve (admin/dispatcher)
  // ---------------------------------------------------------------------
  app.get<{ Params: { id: string; kind: string } }>("/api/jobs/:id/messages/:kind", { preHandler: staffRead }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertMessagingBusiness({ role: req.user!.role, businessId: req.user!.businessId }, job.businessId);
    const viewer: ViewerIdentity = { role: "dispatcher", id: req.user!.sub };
    if (req.params.kind === "legacy") return listLegacyMessages(ctx, req.params.id, viewer, !TERMINAL_JOB_STATUSES.includes(job.status));
    const kind = assertKind(req.params.kind);
    assertReadable(viewer, kind);
    // A dispatcher/admin monitoring customer_rider never registers a
    // read receipt on a conversation they aren't a party to.
    const marksRead = PARTY_KINDS.dispatcher.includes(kind);
    return listMessages(ctx, req.params.id, kind, viewer, !TERMINAL_JOB_STATUSES.includes(job.status), marksRead);
  });

  app.post<{ Params: { id: string; kind: string } }>("/api/jobs/:id/messages/:kind", { preHandler: staffWrite }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertMessagingBusiness({ role: req.user!.role, businessId: req.user!.businessId }, job.businessId);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const viewer: ViewerIdentity = { role: "dispatcher", id: req.user!.sub };
    const kind = assertKind(req.params.kind);
    assertWritable(viewer, kind);
    const body = SendBody.parse(req.body);
    await sendMessage(ctx, req.params.id, job.businessId, kind, "dispatcher", req.user!.sub, body.body, job.riderId, body.clientToken);
    return listMessages(ctx, req.params.id, kind, viewer, true, true);
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/conversations", { preHandler: staffRead }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertMessagingBusiness({ role: req.user!.role, businessId: req.user!.businessId }, job.businessId);
    return conversationsSummary(ctx, req.params.id, { role: "dispatcher", id: req.user!.sub });
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/address-change-requests", { preHandler: staffRead }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertMessagingBusiness({ role: req.user!.role, businessId: req.user!.businessId }, job.businessId);
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
    const job = await ctx.prisma.job.findUnique({ where: { id: req.params.id, deletedAt: null } });
    if (!job) throw httpErrors.createError(404, "Job not found");
    assertMessagingBusiness({ role: req.user!.role, businessId: req.user!.businessId }, job.businessId);

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
    await sendSystemMessage(ctx, req.params.id, job.businessId, job.riderId, `Dispatch confirmed the new delivery address: "${request.proposedAddressText}".`);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "address_change.approve", "job", req.params.id, { requestId: request.id });
    return addressChangeToDto(updated);
  });

  app.post<{ Params: { id: string; reqId: string } }>("/api/jobs/:id/address-change-requests/:reqId/decline", { preHandler: staffWrite }, async (req) => {
    const body = z.object({ note: z.string().max(300).optional().or(z.literal("")) }).parse(req.body ?? {});
    const request = await ctx.prisma.addressChangeRequest.findUnique({ where: { id: req.params.reqId } });
    if (!request || request.jobId !== req.params.id) throw httpErrors.createError(404, "Address change request not found");
    if (request.status !== "pending") throw httpErrors.createError(409, "This request has already been reviewed");
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertMessagingBusiness({ role: req.user!.role, businessId: req.user!.businessId }, job.businessId);
    const updated = await ctx.prisma.addressChangeRequest.update({
      where: { id: request.id },
      data: { status: "declined", reviewedById: req.user!.sub, reviewedAt: new Date(), note: body.note || request.note },
      include: { reviewedBy: { select: { name: true } } },
    });
    await sendSystemMessage(ctx, req.params.id, job.businessId, job.riderId, "Dispatch did not confirm the requested address change. The delivery address is unchanged.");
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "address_change.decline", "job", req.params.id, { requestId: request.id });
    return addressChangeToDto(updated);
  });

  // ---------------------------------------------------------------------
  // Rider side — only the rider actually assigned to the job.
  // ---------------------------------------------------------------------
  function assertOwnJob(req: FastifyRequest, job: { riderId: string | null }): void {
    if (job.riderId !== req.user!.riderId) throw httpErrors.createError(403, "Not your job");
  }

  app.get<{ Params: { id: string; kind: string } }>("/api/bearer/jobs/:id/messages/:kind", { preHandler: ctx.requireRider }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertOwnJob(req, job);
    const viewer: ViewerIdentity = { role: "rider", id: req.user!.riderId! };
    if (req.params.kind === "legacy") return listLegacyMessages(ctx, req.params.id, viewer, !TERMINAL_JOB_STATUSES.includes(job.status));
    const kind = assertKind(req.params.kind);
    assertReadable(viewer, kind);
    return listMessages(ctx, req.params.id, kind, viewer, !TERMINAL_JOB_STATUSES.includes(job.status), true);
  });

  app.post<{ Params: { id: string; kind: string } }>("/api/bearer/jobs/:id/messages/:kind", { preHandler: ctx.requireRider }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertOwnJob(req, job);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const viewer: ViewerIdentity = { role: "rider", id: req.user!.riderId! };
    const kind = assertKind(req.params.kind);
    assertWritable(viewer, kind);
    const body = SendBody.parse(req.body);
    await sendMessage(ctx, req.params.id, job.businessId, kind, "rider", req.user!.riderId!, body.body, job.riderId, body.clientToken);
    return listMessages(ctx, req.params.id, kind, viewer, true, true);
  });

  app.get<{ Params: { id: string } }>("/api/bearer/jobs/:id/conversations", { preHandler: ctx.requireRider }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertOwnJob(req, job);
    return conversationsSummary(ctx, req.params.id, { role: "rider", id: req.user!.riderId! });
  });

  app.post<{ Params: { id: string } }>("/api/bearer/jobs/:id/address-change", { preHandler: ctx.requireRider }, async (req) => {
    const job = await loadJobForMessaging(ctx, req.params.id);
    assertOwnJob(req, job);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) throw httpErrors.createError(409, "This delivery's conversation is closed");
    const body = AddressChangeBody.parse(req.body);
    const request = await ctx.prisma.addressChangeRequest.create({
      data: { jobId: req.params.id, requestedByRole: "rider", proposedAddressText: body.proposedAddressText, note: body.note || null },
    });
    await sendSystemMessage(ctx, req.params.id, job.businessId, job.riderId, `Rider requested a new delivery address: "${body.proposedAddressText}". Waiting for dispatch to confirm.`);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "address_change.request", "job", req.params.id, { requestId: request.id });
    return addressChangeToDto({ ...request, reviewedBy: null });
  });
}

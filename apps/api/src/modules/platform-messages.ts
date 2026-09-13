import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import type { PlatformMessageDto, PlatformMessageSenderRole, PlatformMessagesDto, PlatformMessageThreadDto } from "@ronmacrae/contracts";

/**
 * Non-job-scoped direct messaging (spec: "secure messaging with a strict
 * authorization matrix... admin-to-anyone, logistics<->riders") —
 * deliberately separate from delivery-messages.ts's per-job conversations,
 * which are always tied to exactly one delivery. See schema.prisma's
 * `PlatformMessage` doc comment for the two thread shapes:
 *
 *  - `owner_user`: the platform owner(s) — a shared team inbox, not any one
 *    owner's personal DM box — and one specific User (covers staff,
 *    merchant/logistics portal-only accounts, and riders, since every one
 *    of those is a User row). Routes for each "user" side live in that
 *    face's own module (this file only owns the shared list/send logic
 *    plus the owner's own inbox routes and the generic staff/rider one,
 *    since staff/rider have no other natural home for it).
 *  - `logistics_rider`: one LogisticsCompany and one Rider, valid only
 *    while that rider is actually attached to that company — checked by
 *    the caller (each face's own route) before calling these helpers,
 *    never re-derived here.
 *
 * Deliberately no realtime broadcast and no client-token idempotency dedup
 * here (unlike delivery-messages.ts) — this is a lower-stakes support-chat
 * feature, not live delivery coordination; polling is an acceptable,
 * documented simplification (see WORK_IN_PROGRESS.md's Stage 37 notes).
 */

const MAX_MESSAGE_LENGTH = 1000;
export const SendPlatformMessageBody = z.object({ body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) });

type PlatformMessageRow = {
  id: string;
  senderRole: string;
  senderId: string | null;
  senderName: string | null;
  body: string;
  readAt: Date | null;
  createdAt: Date;
};

function toDto(row: PlatformMessageRow, viewerRole: PlatformMessageSenderRole, viewerId: string): PlatformMessageDto {
  const isSelf = row.senderRole === viewerRole && row.senderId === viewerId;
  return {
    id: row.id,
    senderRole: row.senderRole as PlatformMessageSenderRole,
    isSelf,
    senderName: isSelf ? "You" : row.senderName ?? row.senderRole,
    body: row.body,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listOwnerUserThread(
  ctx: AppCtx,
  targetUserId: string,
  viewerRole: "owner" | "user",
  viewerId: string,
  marksRead: boolean,
): Promise<PlatformMessagesDto> {
  const rows = await ctx.prisma.platformMessage.findMany({ where: { kind: "owner_user", targetUserId }, orderBy: { createdAt: "asc" } });
  if (marksRead) await markRead(ctx, rows, viewerRole);
  return { kind: "owner_user", messages: rows.map((r) => toDto(r, viewerRole, viewerId)) };
}

export async function sendOwnerUserMessage(
  ctx: AppCtx,
  targetUserId: string,
  senderRole: "owner" | "user",
  senderId: string,
  senderName: string,
  body: string,
): Promise<PlatformMessageRow> {
  return ctx.prisma.platformMessage.create({ data: { kind: "owner_user", targetUserId, senderRole, senderId, senderName, body } });
}

export async function listLogisticsRiderThread(
  ctx: AppCtx,
  logisticsCompanyId: string,
  riderId: string,
  viewerRole: "logistics" | "rider",
  viewerId: string,
  marksRead: boolean,
): Promise<PlatformMessagesDto> {
  const rows = await ctx.prisma.platformMessage.findMany({ where: { kind: "logistics_rider", logisticsCompanyId, riderId }, orderBy: { createdAt: "asc" } });
  if (marksRead) await markRead(ctx, rows, viewerRole);
  return { kind: "logistics_rider", messages: rows.map((r) => toDto(r, viewerRole, viewerId)) };
}

export async function sendLogisticsRiderMessage(
  ctx: AppCtx,
  logisticsCompanyId: string,
  riderId: string,
  senderRole: "logistics" | "rider",
  senderId: string,
  senderName: string,
  body: string,
): Promise<PlatformMessageRow> {
  return ctx.prisma.platformMessage.create({ data: { kind: "logistics_rider", logisticsCompanyId, riderId, senderRole, senderId, senderName, body } });
}

async function markRead(ctx: AppCtx, rows: PlatformMessageRow[], viewerRole: string): Promise<void> {
  const now = new Date();
  const unreadIds = rows.filter((r) => r.senderRole !== viewerRole && r.readAt === null).map((r) => r.id);
  if (unreadIds.length === 0) return;
  await ctx.prisma.platformMessage.updateMany({ where: { id: { in: unreadIds } }, data: { readAt: now } });
  for (const r of rows) if (unreadIds.includes(r.id)) r.readAt = now;
}

export async function platformMessageRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const owner = ctx.requireOwner;

  // ---------------------------------------------------------------------
  // Owner side — a shared inbox across every user who has an owner_user
  // thread, and each individual thread.
  // ---------------------------------------------------------------------
  app.get("/api/platform/messages", { preHandler: owner }, async () => {
    const rows = await ctx.prisma.platformMessage.findMany({
      where: { kind: "owner_user" },
      orderBy: { createdAt: "desc" },
      include: { targetUser: { select: { id: true, name: true } } },
    });
    const byUser = new Map<string, PlatformMessageThreadDto>();
    for (const r of rows) {
      if (!r.targetUserId) continue;
      if (!byUser.has(r.targetUserId)) {
        byUser.set(r.targetUserId, {
          userId: r.targetUserId,
          userName: r.targetUser?.name ?? "Unknown",
          unreadCount: 0,
          lastMessage: { body: r.body, senderRole: r.senderRole as PlatformMessageSenderRole, createdAt: r.createdAt.toISOString() },
        });
      }
      if (r.senderRole === "user" && r.readAt === null) byUser.get(r.targetUserId)!.unreadCount++;
    }
    return { threads: [...byUser.values()] };
  });

  app.get<{ Params: { userId: string } }>("/api/platform/messages/:userId", { preHandler: owner }, async (req) => {
    const target = await ctx.prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) throw httpErrors.createError(404, "User not found");
    return listOwnerUserThread(ctx, target.id, "owner", req.user!.sub, true);
  });

  app.post<{ Params: { userId: string } }>("/api/platform/messages/:userId", { preHandler: owner }, async (req) => {
    const target = await ctx.prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) throw httpErrors.createError(404, "User not found");
    const body = SendPlatformMessageBody.parse(req.body);
    await sendOwnerUserMessage(ctx, target.id, "owner", req.user!.sub, req.user!.name, body.body);
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, "platform.message.send", "user", target.id);
    return listOwnerUserThread(ctx, target.id, "owner", req.user!.sub, true);
  });

  // ---------------------------------------------------------------------
  // Generic "message the owner" for any signed-in staff or rider (their
  // own shared access token) — merchant-portal.ts and logistics-portal.ts
  // each have their own equivalent for their own face's token.
  // ---------------------------------------------------------------------
  app.get("/api/messages/owner", { preHandler: ctx.requireAuth }, async (req) => {
    return listOwnerUserThread(ctx, req.user!.sub, "user", req.user!.sub, true);
  });

  app.post("/api/messages/owner", { preHandler: ctx.requireAuth }, async (req) => {
    const body = SendPlatformMessageBody.parse(req.body);
    await sendOwnerUserMessage(ctx, req.user!.sub, "user", req.user!.sub, req.user!.name, body.body);
    return listOwnerUserThread(ctx, req.user!.sub, "user", req.user!.sub, true);
  });
}

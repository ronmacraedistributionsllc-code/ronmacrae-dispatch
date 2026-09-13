import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import { randomBytes } from "node:crypto";
import type { AppCtx } from "../ctx.js";
import { hashPassword } from "../lib/password.js";
import { hashToken } from "../lib/jwt.js";
import { STAFF_ROLES, type StaffRole } from "@ronmacrae/contracts";

/**
 * Real invite/onboarding flow (spec: "Fix the current broken membership
 * experience: if a person is invited/added to a business, they must get
 * a real usable login/onboarding flow—secure invite link or password
 * setup, role, pending/active/disabled status, resend invite, and revoke
 * invite"). This is additive to, not a replacement for, the existing
 * "admin sets a password directly" paths (POST /api/users,
 * /api/merchants/:id/staff) — those still work for an admin who'd rather
 * hand someone a password themselves; this is the alternative where the
 * invited person sets their own.
 *
 * The raw token exists only in the invite email and the accept-invite URL
 * — `Invite.tokenHash` (the same SHA-256-of-token pattern jwt.ts already
 * uses for refresh sessions) is the only thing ever stored.
 */

const INVITE_TTL_DAYS = 7;

function newInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

function inviteLink(ctx: AppCtx, token: string): string {
  return `${ctx.config.APP_ORIGIN}/accept-invite?token=${token}`;
}

async function sendInviteEmail(ctx: AppCtx, email: string, name: string | null, link: string, businessOrMerchantName: string): Promise<void> {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const text = [
    greeting,
    "",
    `You've been invited to join ${businessOrMerchantName} on Ronmacrae Dispatch.`,
    "",
    `Set up your account here (link expires in ${INVITE_TTL_DAYS} days):`,
    link,
    "",
    "If you weren't expecting this, you can ignore this email.",
  ].join("\n");
  await ctx.email.send({ to: email, subject: `You're invited to join ${businessOrMerchantName}`, text });
}

const InviteStaffBody = z.object({
  email: z.string().email().max(160),
  name: z.string().max(120).optional(),
  role: z.enum(STAFF_ROLES),
});

const InviteMerchantBody = z.object({
  email: z.string().email().max(160),
  name: z.string().max(120).optional(),
});

const AcceptBody = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(8).max(128).optional(),
  name: z.string().max(120).optional(),
});

export async function inviteRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const owner = ctx.requireStaff("admin");

  app.post("/api/invites/staff", { preHandler: owner }, async (req) => {
    const body = InviteStaffBody.parse(req.body);
    const businessId = req.user!.businessId!;
    const email = body.email.trim().toLowerCase();
    const token = newInviteToken();
    const invite = await ctx.prisma.invite.create({
      data: {
        email,
        name: body.name || null,
        target: "staff",
        targetId: businessId,
        role: body.role as StaffRole,
        tokenHash: hashToken(token),
        invitedById: req.user!.sub,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000),
      },
    });
    const business = await ctx.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    await sendInviteEmail(ctx, email, invite.name, inviteLink(ctx, token), business.name);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "invite.create", "invite", invite.id, { email, target: "staff", role: body.role });
    return { invite: inviteToDto(invite) };
  });

  app.post<{ Params: { merchantId: string } }>("/api/invites/merchant/:merchantId", { preHandler: owner }, async (req) => {
    const body = InviteMerchantBody.parse(req.body);
    const merchant = await ctx.prisma.merchant.findFirst({ where: { id: req.params.merchantId, businessId: req.user!.businessId! } });
    if (!merchant) throw httpErrors.createError(404, "Merchant not found");
    const email = body.email.trim().toLowerCase();
    const token = newInviteToken();
    const invite = await ctx.prisma.invite.create({
      data: {
        email,
        name: body.name || null,
        target: "merchant",
        targetId: merchant.id,
        tokenHash: hashToken(token),
        invitedById: req.user!.sub,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000),
      },
    });
    await sendInviteEmail(ctx, email, invite.name, inviteLink(ctx, token), merchant.name);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "invite.create", "invite", invite.id, { email, target: "merchant", merchantId: merchant.id });
    return { invite: inviteToDto(invite) };
  });

  // Every pending/accepted/revoked invite this business (staff invites) or
  // its own merchants (merchant invites) has ever sent — one combined list
  // so the Team screen can show a single "Invites" section.
  app.get("/api/invites", { preHandler: owner }, async (req) => {
    const businessId = req.user!.businessId!;
    const merchantIds = (await ctx.prisma.merchant.findMany({ where: { businessId }, select: { id: true } })).map((m) => m.id);
    const invites = await ctx.prisma.invite.findMany({
      where: { OR: [{ target: "staff", targetId: businessId }, { target: "merchant", targetId: { in: merchantIds } }] },
      orderBy: { createdAt: "desc" },
    });
    return { invites: invites.map(inviteToDto) };
  });

  app.post<{ Params: { id: string } }>("/api/invites/:id/resend", { preHandler: owner }, async (req) => {
    const invite = await requireOwnedInvite(ctx, req.user!.businessId!, req.params.id);
    if (invite.status !== "pending") throw httpErrors.createError(409, `This invite was already ${invite.status} — can't resend it.`);
    const token = newInviteToken();
    const updated = await ctx.prisma.invite.update({
      where: { id: invite.id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000) },
    });
    const name = await targetName(ctx, invite);
    await sendInviteEmail(ctx, invite.email, invite.name, inviteLink(ctx, token), name);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "invite.resend", "invite", invite.id);
    return { invite: inviteToDto(updated) };
  });

  app.post<{ Params: { id: string } }>("/api/invites/:id/revoke", { preHandler: owner }, async (req) => {
    const invite = await requireOwnedInvite(ctx, req.user!.businessId!, req.params.id);
    if (invite.status !== "pending") throw httpErrors.createError(409, `This invite was already ${invite.status}.`);
    const updated = await ctx.prisma.invite.update({ where: { id: invite.id }, data: { status: "revoked", revokedAt: new Date() } });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "invite.revoke", "invite", invite.id);
    return { invite: inviteToDto(updated) };
  });

  // ---------------------------------------------------------------------
  // Public — no auth. The invite token itself is the credential.
  // ---------------------------------------------------------------------
  app.get<{ Params: { token: string } }>("/api/invites/check/:token", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const invite = await ctx.prisma.invite.findUnique({ where: { tokenHash: hashToken(req.params.token) } });
    if (!invite) throw httpErrors.createError(404, "This invite link isn't valid.");
    if (invite.status !== "pending") throw httpErrors.createError(400, `This invite was already ${invite.status}.`);
    if (invite.expiresAt < new Date()) throw httpErrors.createError(400, "This invite link has expired — ask for a new one.");
    const existing = await ctx.prisma.user.findUnique({ where: { email: invite.email }, select: { id: true } });
    const name = await targetName(ctx, invite);
    return { email: invite.email, name: invite.name, target: invite.target, targetName: name, needsPassword: existing == null };
  });

  app.post("/api/invites/accept", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const body = AcceptBody.parse(req.body);
    const invite = await ctx.prisma.invite.findUnique({ where: { tokenHash: hashToken(body.token) } });
    if (!invite) throw httpErrors.createError(404, "This invite link isn't valid.");
    if (invite.status !== "pending") throw httpErrors.createError(400, `This invite was already ${invite.status}.`);
    if (invite.expiresAt < new Date()) throw httpErrors.createError(400, "This invite link has expired — ask for a new one.");

    const existing = await ctx.prisma.user.findUnique({ where: { email: invite.email } });
    let userId: string;
    if (existing) {
      // One account, many memberships — never touch an existing password.
      userId = existing.id;
    } else {
      if (!body.password) throw httpErrors.createError(400, "Choose a password to finish setting up your account.");
      const created = await ctx.prisma.user.create({
        data: {
          email: invite.email,
          name: body.name || invite.name || invite.email,
          passwordHash: hashPassword(body.password),
          role: invite.target === "staff" ? (invite.role ?? "viewer") : "viewer",
          // Accepting a link sent to this exact address is itself proof of
          // ownership — no separate code needed on top of it.
          emailVerifiedAt: new Date(),
        },
      });
      userId = created.id;
    }

    if (invite.target === "staff") {
      await ctx.prisma.staffMembership.upsert({
        where: { userId_businessId: { userId, businessId: invite.targetId } },
        create: { userId, businessId: invite.targetId, role: invite.role ?? "viewer", active: true },
        update: { active: true, role: invite.role ?? undefined },
      });
    } else {
      await ctx.prisma.merchantStaff.upsert({
        where: { userId_merchantId: { userId, merchantId: invite.targetId } },
        create: { userId, merchantId: invite.targetId, active: true },
        update: { active: true },
      });
    }
    await ctx.prisma.invite.update({ where: { id: invite.id }, data: { status: "accepted", acceptedAt: new Date() } });
    await ctx.audit.record({ id: userId, role: "invited" }, "invite.accept", "invite", invite.id, { hadExistingAccount: existing != null });
    return { ok: true, hadExistingAccount: existing != null, email: invite.email };
  });
}

async function requireOwnedInvite(ctx: AppCtx, businessId: string, id: string) {
  const invite = await ctx.prisma.invite.findUnique({ where: { id } });
  if (!invite) throw httpErrors.createError(404, "Invite not found");
  if (invite.target === "staff" && invite.targetId !== businessId) throw httpErrors.createError(404, "Invite not found");
  if (invite.target === "merchant") {
    const merchant = await ctx.prisma.merchant.findFirst({ where: { id: invite.targetId, businessId } });
    if (!merchant) throw httpErrors.createError(404, "Invite not found");
  }
  return invite;
}

async function targetName(ctx: AppCtx, invite: { target: string; targetId: string }): Promise<string> {
  if (invite.target === "staff") {
    const business = await ctx.prisma.business.findUnique({ where: { id: invite.targetId } });
    return business?.name ?? "this business";
  }
  const merchant = await ctx.prisma.merchant.findUnique({ where: { id: invite.targetId } });
  return merchant?.name ?? "this store";
}

function inviteToDto(i: {
  id: string;
  email: string;
  name: string | null;
  target: string;
  targetId: string;
  role: string | null;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: i.id,
    email: i.email,
    name: i.name,
    target: i.target,
    targetId: i.targetId,
    role: i.role,
    status: i.status,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    acceptedAt: i.acceptedAt?.toISOString() ?? null,
    revokedAt: i.revokedAt?.toISOString() ?? null,
  };
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { hashToken, newJti } from "../lib/jwt.js";
import { verifyTotp } from "../lib/totp.js";
import type { Role, UserDto } from "@ronmacrae/contracts";

const REFRESH_COOKIE = "rmd_refresh";

export function toUserDto(u: {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  active: boolean;
  totpEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  platformRole?: string | null;
  theme?: string | null;
}): UserDto {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    active: u.active,
    totpEnabled: u.totpEnabled,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    platformRole: u.platformRole === "owner" ? "owner" : null,
    theme: u.theme ?? null,
  };
}

const LoginBody = z.object({
  identifier: z.string().min(3),
  password: z.string().min(1),
  totpCode: z.string().max(8).optional(),
  /** Selects which business to sign into, for a staff member with more than
   *  one active StaffMembership. Omitted (the common case — one membership,
   *  or a rider/owner login) defaults to their only/first one; there is no
   *  business-switcher UI yet, so a multi-business admin currently has to
   *  log in again with this to reach a second business. */
  businessId: z.string().optional(),
  /** Finalizes a workspace:"select" response (an account with more than
   *  one merchant/logistics workspace and no staff/rider access at all) —
   *  the frontend re-submits the exact same credentials plus the chosen
   *  id, rather than a separate confirm endpoint. Ignored for an account
   *  that has staff/rider access (that path never returns "select" today).
   *  `merchantId` is the original, kept for backward compatibility;
   *  `workspaceId` is the generalized name (works for either type) — both
   *  are checked against the combined list. */
  merchantId: z.string().optional(),
  workspaceId: z.string().optional(),
});

interface StaffContext {
  businessId: string | null;
  role: Role;
  platformRole: "owner" | null;
  memberships: { businessId: string; businessName: string; role: Role }[];
}

/** Resolves which business (and role at that business) this login/refresh
 *  is for. A platform owner gets no businessId at all — the owner console
 *  is separate, business-scoped routes never accept an owner's token (see
 *  guards.ts's requireStaff, which requires a businessId, not just a role
 *  match) rather than silently treating "no business" as "every business".
 *
 *  Returns `null` (never throws) when the user has no active staff
 *  membership and isn't a rider or platform owner — the caller decides
 *  what that means: /api/auth/login falls through to check merchant-portal
 *  access before giving up, while /api/auth/refresh (a session that could
 *  only exist by having resolved successfully at login time) treats it as
 *  the account having been removed out from under an existing session and
 *  throws via requireStaffContext below. */
async function realStaffMemberships(ctx: AppCtx, userId: string) {
  const staffMemberships = await ctx.prisma.staffMembership.findMany({
    where: { userId, active: true },
    include: { business: { select: { id: true, name: true } } },
  });
  return staffMemberships.map((m) => ({ businessId: m.businessId, businessName: m.business.name, role: m.role }));
}

/**
 * Roles and memberships (spec: "one account may legitimately have
 * multiple roles... courier + store manager + logistics dispatcher,
 * without needing three separate accounts") — StaffMembership,
 * MerchantStaff, LogisticsCompanyStaff, and a Rider profile were always
 * independent rows keyed off the same shared User, so one account could
 * already HOLD all of them. What this function got wrong: a rider-role
 * account short-circuited here unconditionally, before ever checking
 * whether it also had real, active StaffMembership rows — meaning a
 * courier who was ALSO a dispatcher could never actually use that staff
 * access through the shared login, no matter how many StaffMembership
 * rows an admin had genuinely granted them. Fixed: the rider branch now
 * resolves real staff memberships the exact same way the non-rider
 * branch always has, and only falls back to `businessId: null` when
 * there genuinely are none — every existing rider-only account (the
 * common case) sees zero behavior change.
 */
export async function resolveStaffContext(
  ctx: AppCtx,
  user: { id: string; role: Role; platformRole: string | null },
  requestedBusinessId?: string,
): Promise<StaffContext | null> {
  if (user.platformRole === "owner") {
    return { businessId: null, role: user.role, platformRole: "owner", memberships: [] };
  }
  if (user.role === "rider") {
    const memberships = await realStaffMemberships(ctx, user.id);
    if (memberships.length === 0) {
      return { businessId: null, role: user.role, platformRole: null, memberships: [] };
    }
    const chosen =
      (requestedBusinessId ? memberships.find((m) => m.businessId === requestedBusinessId) : undefined) ?? memberships[0]!;
    return { businessId: chosen.businessId, role: chosen.role, platformRole: null, memberships };
  }
  const memberships = await realStaffMemberships(ctx, user.id);
  if (memberships.length === 0) return null;
  const chosen =
    (requestedBusinessId ? memberships.find((m) => m.businessId === requestedBusinessId) : undefined) ?? memberships[0]!;
  return { businessId: chosen.businessId, role: chosen.role, platformRole: null, memberships };
}

async function requireStaffContext(
  ctx: AppCtx,
  user: { id: string; role: Role; platformRole: string | null },
  requestedBusinessId?: string,
): Promise<StaffContext> {
  const resolved = await resolveStaffContext(ctx, user, requestedBusinessId);
  if (!resolved) throw httpErrors.createError(403, "This account has no active business membership");
  return resolved;
}

/** A merchant-portal workspace this user can switch into, surfaced
 *  alongside a successful staff login (or offered on its own when the
 *  account has no staff/rider access at all) — see /api/auth/login and
 *  /api/auth/switch-to-merchant. */
async function merchantWorkspacesFor(ctx: AppCtx, userId: string) {
  const rows = await ctx.prisma.merchantStaff.findMany({
    where: { userId, active: true, merchant: { active: true } },
    include: { merchant: { select: { id: true, name: true } } },
  });
  return rows.map((r) => ({ type: "merchant" as const, id: r.merchant.id, name: r.merchant.name }));
}

/** Same idea as merchantWorkspacesFor, for a logistics-company portal
 *  workspace — see /api/auth/login and /api/auth/switch-to-logistics. */
async function logisticsWorkspacesFor(ctx: AppCtx, userId: string) {
  const rows = await ctx.prisma.logisticsCompanyStaff.findMany({
    where: { userId, active: true, logisticsCompany: { active: true } },
    include: { logisticsCompany: { select: { id: true, name: true } } },
  });
  return rows.map((r) => ({ type: "logistics" as const, id: r.logisticsCompany.id, name: r.logisticsCompany.name }));
}

export async function authRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post("/api/auth/login", async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const identifier = body.identifier.trim();
    const isPhone = /^\+?[0-9\s-]{7,15}$/.test(identifier);
    const user = await ctx.prisma.user.findFirst({
      where: isPhone ? { phone: normalizePhone(identifier) } : { email: identifier.toLowerCase() },
      include: { rider: { select: { id: true } } },
    });
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      throw httpErrors.createError(401, "Invalid credentials");
    }
    // Checked before the plain "disabled" case — a distinct, honest status
    // (spec: PENDING/ACTIVE/SUSPENDED/REJECTED/DELETED are separate
    // states), never the generic message a merely-suspended account gets.
    if (user.deletedAt) throw httpErrors.createError(403, "Account deleted");
    if (!user.active) throw httpErrors.createError(403, "Account disabled");
    // Email verification is no longer a login gate for anyone, riders
    // included (a never-delivered verification email — a real production
    // failure mode, see sendEmailCode's doc comment in
    // customer-account.ts — must never be able to permanently lock out an
    // otherwise-legitimate account). A rider's actual job access is
    // already separately gated by RiderMembership/platformStatus per
    // route, not by this login check.
    if (user.totpEnabled && user.totpSecret) {
      if (!body.totpCode || !verifyTotp(user.totpSecret, body.totpCode)) {
        throw httpErrors.createError(401, "TOTP code required");
      }
    }
    // One shared sign-in for everyone (spec: "no separate rider, merchant,
    // logistics, or admin login pages") — the same credentials are checked
    // against staff/rider access first, then merchant/logistics-portal
    // access, rather than the caller having to know in advance which kind
    // of account this is or visit a different page for each.
    const staffContext = await resolveStaffContext(ctx, user, body.businessId);
    const merchantWorkspaces = await merchantWorkspacesFor(ctx, user.id);
    const logisticsWorkspaces = await logisticsWorkspacesFor(ctx, user.id);
    const otherWorkspaces = [...merchantWorkspaces, ...logisticsWorkspaces];

    if (!staffContext) {
      if (otherWorkspaces.length === 0) {
        // Genuinely no accessible workspace — a clear, honest explanation,
        // never a silent or generic failure (spec: "if they genuinely have
        // no membership, give a clear explanation and no unauthorized access").
        throw httpErrors.createError(
          403,
          "This account isn't connected to any business yet. Ask an admin to add you, or check for an invite.",
        );
      }
      const requestedId = body.workspaceId ?? body.merchantId;
      const chosen = requestedId ? otherWorkspaces.find((w) => w.id === requestedId) : undefined;
      if (otherWorkspaces.length > 1 && !chosen) {
        // More than one merchant/logistics workspace and no staff access at
        // all — needs an explicit choice, no token issued yet.
        return { workspace: "select" as const, options: otherWorkspaces };
      }
      const only = chosen ?? otherWorkspaces[0]!;
      if (only.type === "logistics") {
        const token = await ctx.jwt.issueLogisticsPortal(user.id, only.id);
        await ctx.audit.record({ id: user.id, role: "logistics" }, "auth.login", "user", user.id);
        return { workspace: "logistics" as const, token, logisticsCompany: { id: only.id, name: only.name } };
      }
      const token = await ctx.jwt.issueMerchantPortal(user.id, only.id);
      await ctx.audit.record({ id: user.id, role: "merchant" }, "auth.login", "user", user.id);
      return { workspace: "merchant" as const, token, merchant: { id: only.id, name: only.name } };
    }

    const tokenPair = await issueTokenPair(ctx, user, staffContext, req.headers["user-agent"]);
    await ctx.audit.record({ id: user.id, role: user.role }, "auth.login", "user", user.id);
    reply.setCookie(REFRESH_COOKIE, tokenPair.refresh, {
      path: "/api/auth",
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.config.APP_ORIGIN.startsWith("https"),
      expires: tokenPair.expiresAt,
    });
    return {
      workspace: "staff" as const,
      user: toUserDto(user),
      riderId: user.rider?.id ?? null,
      businessId: staffContext.businessId,
      platformRole: staffContext.platformRole,
      memberships: staffContext.memberships,
      accessToken: tokenPair.access,
      // Surfaced so the app can offer "Switch workspace" without a second
      // login — see /api/auth/switch-to-merchant and switch-to-logistics.
      // Empty for the common single-workspace case.
      otherWorkspaces,
    };
  });

  // Lets an already-authenticated staff/rider session jump into a merchant
  // workspace it also has access to, without a second password entry —
  // the "switch workspace" the spec asks for, not a second login page.
  app.post("/api/auth/switch-to-merchant", { preHandler: ctx.requireAuth }, async (req) => {
    const body = z.object({ merchantId: z.string().optional() }).parse(req.body ?? {});
    const workspaces = await merchantWorkspacesFor(ctx, req.user!.sub);
    if (workspaces.length === 0) throw httpErrors.createError(403, "This account has no merchant access to switch to.");
    const target = body.merchantId ? workspaces.find((w) => w.id === body.merchantId) : workspaces[0];
    if (!target) throw httpErrors.createError(404, "Merchant workspace not found");
    const token = await ctx.jwt.issueMerchantPortal(req.user!.sub, target.id);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "auth.switch_workspace", "merchant", target.id);
    return { token, merchant: { id: target.id, name: target.name } };
  });

  // Same as switch-to-merchant, for a logistics-company workspace.
  app.post("/api/auth/switch-to-logistics", { preHandler: ctx.requireAuth }, async (req) => {
    const body = z.object({ logisticsCompanyId: z.string().optional() }).parse(req.body ?? {});
    const workspaces = await logisticsWorkspacesFor(ctx, req.user!.sub);
    if (workspaces.length === 0) throw httpErrors.createError(403, "This account has no logistics company access to switch to.");
    const target = body.logisticsCompanyId ? workspaces.find((w) => w.id === body.logisticsCompanyId) : workspaces[0];
    if (!target) throw httpErrors.createError(404, "Logistics company workspace not found");
    const token = await ctx.jwt.issueLogisticsPortal(req.user!.sub, target.id);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "auth.switch_workspace", "logistics_company", target.id);
    return { token, logisticsCompany: { id: target.id, name: target.name } };
  });

  app.post("/api/auth/refresh", async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw httpErrors.createError(401, "Missing refresh token");
    const payload = await ctx.jwt.verifyRefresh(token);
    if (!payload) throw httpErrors.createError(401, "Invalid refresh token");
    const session = await ctx.prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!session || session.expiresAt < new Date()) throw httpErrors.createError(401, "Session expired");
    const user = await ctx.prisma.user.findUnique({
      where: { id: session.userId },
      include: { rider: { select: { id: true } } },
    });
    if (!user || !user.active) throw httpErrors.createError(401, "Account unavailable");
    // rotate: invalidate only the presented session; the user's other active
    // sessions (other devices/tabs) must survive the refresh
    await ctx.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    // Carry the session's own business forward rather than re-resolving from
    // scratch — a multi-business admin's session must not silently jump to a
    // different business (e.g. "first membership") on every token refresh.
    const staffContext = session.businessId
      ? await requireStaffContext(ctx, user, session.businessId)
      : await requireStaffContext(ctx, user);
    const tokenPair = await issueTokenPair(ctx, user, staffContext, req.headers["user-agent"]);
    reply.setCookie(REFRESH_COOKIE, tokenPair.refresh, {
      path: "/api/auth",
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.config.APP_ORIGIN.startsWith("https"),
      expires: tokenPair.expiresAt,
    });
    return {
      user: toUserDto(user),
      riderId: user.rider?.id ?? null,
      businessId: staffContext.businessId,
      platformRole: staffContext.platformRole,
      accessToken: tokenPair.access,
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      const payload = await ctx.jwt.verifyRefresh(token);
      if (payload) await ctx.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
    if (req.user) {
      await ctx.prisma.session.deleteMany({ where: { userId: req.user.sub } });
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: ctx.requireAuth }, async (req) => {
    const user = await ctx.prisma.user.findUnique({
      where: { id: req.user!.sub },
      include: { rider: { include: { homeZone: { select: { name: true } } } } },
    });
    if (!user) throw httpErrors.createError(401, "User not found");
    const { riderToDto, currentJobIdFor } = await import("./riders.js");
    const rider = user.rider
      ? riderToDto(user.rider, { currentJobId: await currentJobIdFor(ctx, user.rider.id) })
      : null;
    // Kept available for the whole session (not just the login instant) so
    // a "Switch workspace" control can show up anywhere in the app, not
    // only right after signing in.
    const otherWorkspaces = [...(await merchantWorkspacesFor(ctx, user.id)), ...(await logisticsWorkspacesFor(ctx, user.id))];
    // Admin impersonation (spec: a highly visible, unmissable banner
    // while active) — null on every ordinary session; only set on a
    // token POST /api/platform/users/:id/impersonate issued, where it's
    // the admin's own id (never this user's). Looked up here (not just
    // passed straight from the token) so the banner can show a real name,
    // not a bare id.
    const impersonatedBy = req.user!.impersonatedBy
      ? await ctx.prisma.user.findUnique({ where: { id: req.user!.impersonatedBy }, select: { id: true, name: true } })
      : null;
    // Both reflect THIS session's own token (req.user, already decoded),
    // not a fresh recomputation — a rider who also holds real
    // StaffMembership rows (see resolveStaffContext's own doc comment)
    // has a businessId and a real staff effectiveRole here too; a rider
    // with none still gets businessId: null / effectiveRole: "rider",
    // unchanged. `user.role` (in the UserDto above) is the stable,
    // identity-level DB column and never changes with which business is
    // chosen — `effectiveRole` is the actually-granted role for THIS
    // session, the same one requireStaff() itself checks server-side, and
    // is what role-gated nav (layout.tsx) needs to ask instead.
    return { user: toUserDto(user), rider, otherWorkspaces, businessId: req.user!.businessId ?? null, effectiveRole: req.user!.role, impersonatedBy };
  });

  // Stage E (spec: theme switcher, "persist per user") — any signed-in
  // staff or rider, their own shared access token. `theme` is free text,
  // not validated against the current THEMES list server-side: the
  // frontend's own allow-list is what decides what's selectable, and an
  // id from an older/newer client (or a removed theme) simply falls back
  // to the default rather than needing a server-side migration.
  app.put("/api/auth/theme", { preHandler: ctx.requireAuth }, async (req) => {
    const body = z.object({ theme: z.string().max(60).nullable() }).parse(req.body);
    await ctx.prisma.user.update({ where: { id: req.user!.sub }, data: { theme: body.theme } });
    return { ok: true };
  });

  app.put("/api/auth/password", { preHandler: ctx.requireAuth }, async (req) => {
    const body = z.object({ current: z.string().min(1), next: z.string().min(8).max(128) }).parse(req.body);
    const user = await ctx.prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw httpErrors.createError(401, "User not found");
    if (!verifyPassword(body.current, user.passwordHash)) throw httpErrors.createError(400, "Current password incorrect");
    await ctx.prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(body.next) } });
    await ctx.prisma.session.deleteMany({ where: { userId: user.id } });
    await ctx.audit.record({ id: user.id, role: user.role }, "auth.password_change", "user", user.id);
    return { ok: true };
  });

  // ---- TOTP (privileged accounts) ----
  app.post("/api/auth/totp/enroll", { preHandler: ctx.requireAuth }, async (req) => {
    const { generateTotpSecret, totpUri } = await import("../lib/totp.js");
    const user = await ctx.prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw httpErrors.createError(401, "User not found");
    const secret = generateTotpSecret();
    return { secret, uri: totpUri(secret, user.email ?? user.phone ?? user.id) };
  });

  app.post("/api/auth/totp/verify", { preHandler: ctx.requireAuth }, async (req) => {
    const body = z.object({ secret: z.string().min(8), code: z.string().length(6) }).parse(req.body);
    const { verifyTotp } = await import("../lib/totp.js");
    if (!verifyTotp(body.secret, body.code)) throw httpErrors.createError(400, "Invalid code");
    const user = await ctx.prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw httpErrors.createError(401, "User not found");
    if (!["admin", "accountant"].includes(user.role)) throw httpErrors.createError(403, "TOTP is only for privileged roles");
    await ctx.prisma.user.update({ where: { id: user.id }, data: { totpSecret: body.secret, totpEnabled: true } });
    await ctx.audit.record({ id: user.id, role: user.role }, "auth.totp_enable", "user", user.id);
    return { ok: true };
  });
}

async function issueTokenPair(
  ctx: AppCtx,
  user: { id: string; name: string; role: Role; rider?: { id: string } | null },
  staffContext: StaffContext,
  userAgent: string | undefined,
) {
  const access = await ctx.jwt.issueAccess({
    id: user.id,
    name: user.name,
    role: staffContext.role,
    riderId: user.rider?.id,
    businessId: staffContext.businessId ?? undefined,
    platformRole: staffContext.platformRole ?? undefined,
  });
  const jti = newJti();
  const { token: refresh, expiresAt } = await ctx.jwt.issueRefresh({ id: user.id }, jti);
  await ctx.prisma.session.create({
    data: {
      id: jti,
      userId: user.id,
      tokenHash: hashToken(refresh),
      userAgent: userAgent?.slice(0, 200),
      businessId: staffContext.businessId,
      expiresAt,
    },
  });
  await ctx.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { access, refresh, expiresAt };
}

/**
 * Legacy normalizer for login/Customer/Rider/User records — kept
 * deliberately producing the exact same "+876XXXXXXX" shape it always has
 * (never the real E.164 "+1876XXXXXXX" shape `lib/phone.ts`'s real
 * normalizer uses for the global CustomerIdentity system), so every phone
 * number already stored this way keeps matching. `lib/phone.ts`'s own
 * normalizer is intentionally not reused here — unifying the two would mean
 * re-migrating every already-stored User/Rider/Customer phone, a genuinely
 * separate cleanup outside this fix's scope (see WORK_IN_PROGRESS.md).
 *
 * Fixed here (Stage 30, spec section 8): a Jamaican number typed with or
 * without the "1" country-code digit — "8765551234", "18765551234", and
 * "+18765551234" — must all collapse to the one same customer profile, not
 * three. The previous version only handled the with-country-code and
 * without-country-code forms as accidentally-different shapes; this
 * strips a leading "1876" down to "876" first, so every form canonicalizes
 * identically.
 */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1876")) digits = digits.slice(1);
  if (digits.length === 7) digits = `876${digits}`;
  return `+${digits}`;
}

/** Global auth hook: validates the bearer token on /api/* (with an allow-list). */
export function registerAuthHook(app: FastifyInstance, ctx: AppCtx): void {
  const allow = (method: string, url: string): boolean => {
    if (url === "/api/health") return true;
    if (url.startsWith("/api/tracking/") && method === "GET") return true;
    // customer-side delivery messaging (spec 5G) — gated by the tracking
    // token itself (validated inside the route), not a login. Scoped to
    // these exact suffixes so /api/tracking/:jobId (create link) and
    // /api/tracking/:token/revoke (both staff-only) stay protected.
    // Stage 24: messages moved from /api/tracking/:token/messages to
    // /api/tracking/:token/messages/:kind (one per conversation) — the
    // trailing segment is now a conversation kind, not a fixed suffix.
    if (url.startsWith("/api/tracking/") && method === "POST" && (/\/messages\/[^/]+$/.test(url) || url.endsWith("/address-change") || url.endsWith("/rate") || url.endsWith("/rate-merchant"))) return true;
    if (url === "/api/auth/login" || url === "/api/auth/refresh") return true;
    // Cross-business customer package dashboard (spec 4) — no staff/rider
    // login; request-code/verify are phone-gated, and the dashboard list
    // itself is gated inside the route by its own short-lived token (same
    // "checked inside the route, not by this global hook" convention as the
    // tracking-messages routes just above).
    if (url === "/api/customer-dashboard/request-code" && method === "POST") return true;
    if (url === "/api/customer-dashboard/verify" && method === "POST") return true;
    if (url === "/api/customer-dashboard" && method === "GET") return true;
    // Customer account-claim / sign-in (spec 7, Stage 25) — same "checked
    // inside the route" convention: status/claim/resend-verification are
    // gated by the customer-dashboard Bearer token itself, the rest by the
    // email code or password they present.
    if (url.startsWith("/api/customer-account/") && (method === "POST" || method === "GET")) return true;
    // public customer-facing endpoints (rate limited)
    if (url === "/api/delivery-requests" && method === "POST") return true;
    if (url === "/api/quotes/public" && method === "POST") return true;
    if (url === "/api/geo/geocode" && method === "POST") return true;
    if (url === "/api/geo/reverse" && method === "POST") return true;
    // Main public multi-item order form (spec section 5) — no login, no
    // app. `/api/order`, `/api/order/quote`, and `/api/order/:merchantSlug`
    // all covered by this one prefix check.
    if ((url === "/api/order" || url.startsWith("/api/order/")) && method === "POST") return true;
    // A merchant's public storefront info + catalog for their own /order/:slug page.
    if (url.startsWith("/api/merchants/public/") && method === "GET") return true;
    // Public rider application — no login (this IS how a rider gets one).
    if (url === "/api/rider-signup" && method === "POST") return true;
    if ((url === "/api/rider-signup/verify" || url === "/api/rider-signup/resend") && method === "POST") return true;
    if ((url === "/api/merchant-signup" || url === "/api/merchant-signup/verify" || url === "/api/merchant-signup/resend") && method === "POST") return true;
    // Public Bearer/Logistics Company application — the spec's fourth
    // shared-signup account type, same "no login, this IS how you get one"
    // rule as rider-signup/merchant-signup above.
    if ((url === "/api/logistics-signup" || url === "/api/logistics-signup/verify" || url === "/api/logistics-signup/resend") && method === "POST") return true;
    // Merchant portal — login is public by nature; every other route under
    // this prefix is gated by its own merchant_portal Bearer token inside
    // the handler (requireMerchantAuth in merchant-portal.ts), same
    // "self-gated, not the staff hook" pattern as /api/customer-account/.
    if (url.startsWith("/api/merchant-portal/")) return true;
    // Logistics/bearer-company portal — same "self-gated" pattern as the
    // merchant portal above (requireLogisticsAuth in logistics-portal.ts).
    if (url.startsWith("/api/logistics-portal/")) return true;
    // Invite acceptance — the invite token itself is the credential, same
    // "self-gated, not the staff hook" pattern as the merchant portal.
    if (url.startsWith("/api/invites/check/") && method === "GET") return true;
    if (url === "/api/invites/accept" && method === "POST") return true;
    // Twilio's own delivery-status webhook — unauthenticated by nature (Twilio
    // isn't a logged-in user), verified instead by its own signature header
    // when TWILIO_AUTH_TOKEN is configured (see notify.ts).
    if (url === "/api/notifications/twilio-status" && method === "POST") return true;
    return false;
  };
  app.addHook("onRequest", async (req, reply) => {
    if (!req.raw.url?.startsWith("/api/")) return;
    const path = req.raw.url.split("?")[0]!;
    if (allow(req.method, path)) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      reply.code(401).send({ error: { message: "Authentication required" } });
      return reply;
    }
    const payload = await ctx.jwt.verifyAccess(token);
    if (!payload) {
      reply.code(401).send({ error: { message: "Invalid or expired token" } });
      return reply;
    }
    req.user = payload;
  });
}

export { REFRESH_COOKIE };

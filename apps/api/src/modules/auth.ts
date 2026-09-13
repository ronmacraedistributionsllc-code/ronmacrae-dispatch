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
 *  match) rather than silently treating "no business" as "every business". */
async function resolveStaffContext(
  ctx: AppCtx,
  user: { id: string; role: Role; platformRole: string | null },
  requestedBusinessId?: string,
): Promise<StaffContext> {
  if (user.platformRole === "owner") {
    return { businessId: null, role: user.role, platformRole: "owner", memberships: [] };
  }
  if (user.role === "rider") {
    return { businessId: null, role: user.role, platformRole: null, memberships: [] };
  }
  const staffMemberships = await ctx.prisma.staffMembership.findMany({
    where: { userId: user.id, active: true },
    include: { business: { select: { id: true, name: true } } },
  });
  const memberships = staffMemberships.map((m) => ({ businessId: m.businessId, businessName: m.business.name, role: m.role }));
  if (memberships.length === 0) {
    throw httpErrors.createError(403, "This account has no active business membership");
  }
  const chosen =
    (requestedBusinessId ? memberships.find((m) => m.businessId === requestedBusinessId) : undefined) ?? memberships[0]!;
  return { businessId: chosen.businessId, role: chosen.role, platformRole: null, memberships };
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
    if (!user.active) throw httpErrors.createError(403, "Account disabled");
    // Only a rider's own public self-signup (riders.ts) ever leaves email
    // unverified — an admin/dispatcher directly creating any login (staff
    // or rider) is itself the vouching, and sets emailVerifiedAt right
    // away, so this never blocks those.
    if (user.role === "rider" && user.email && !user.emailVerifiedAt) {
      throw httpErrors.createError(403, "Please verify your email before signing in — check your inbox for the code.");
    }
    if (user.totpEnabled && user.totpSecret) {
      if (!body.totpCode || !verifyTotp(user.totpSecret, body.totpCode)) {
        throw httpErrors.createError(401, "TOTP code required");
      }
    }
    const staffContext = await resolveStaffContext(ctx, user, body.businessId);
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
      user: toUserDto(user),
      riderId: user.rider?.id ?? null,
      businessId: staffContext.businessId,
      platformRole: staffContext.platformRole,
      memberships: staffContext.memberships,
      accessToken: tokenPair.access,
    };
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
      ? await resolveStaffContext(ctx, user, session.businessId)
      : await resolveStaffContext(ctx, user);
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
    return { user: toUserDto(user), rider };
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
    if (url.startsWith("/api/tracking/") && method === "POST" && (/\/messages\/[^/]+$/.test(url) || url.endsWith("/address-change"))) return true;
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
    // Merchant portal — login is public by nature; every other route under
    // this prefix is gated by its own merchant_portal Bearer token inside
    // the handler (requireMerchantAuth in merchant-portal.ts), same
    // "self-gated, not the staff hook" pattern as /api/customer-account/.
    if (url.startsWith("/api/merchant-portal/")) return true;
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

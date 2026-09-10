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
});

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
    if (user.totpEnabled && user.totpSecret) {
      if (!body.totpCode || !verifyTotp(user.totpSecret, body.totpCode)) {
        throw httpErrors.createError(401, "TOTP code required");
      }
    }
    const tokenPair = await issueTokenPair(ctx, user, req.headers["user-agent"]);
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
    const tokenPair = await issueTokenPair(ctx, user, req.headers["user-agent"]);
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
  userAgent: string | undefined,
) {
  const access = await ctx.jwt.issueAccess({
    id: user.id,
    name: user.name,
    role: user.role,
    riderId: user.rider?.id,
  });
  const jti = newJti();
  const { token: refresh, expiresAt } = await ctx.jwt.issueRefresh({ id: user.id }, jti);
  await ctx.prisma.session.create({
    data: {
      id: jti,
      userId: user.id,
      tokenHash: hashToken(refresh),
      userAgent: userAgent?.slice(0, 200),
      expiresAt,
    },
  });
  await ctx.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { access, refresh, expiresAt };
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10 && digits.startsWith("1876")) return `+876${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("876")) return `+${digits}`;
  if (digits.length === 7) return `+876${digits}`;
  return `+${digits}`;
}

/** Global auth hook: validates the bearer token on /api/* (with an allow-list). */
export function registerAuthHook(app: FastifyInstance, ctx: AppCtx): void {
  const allow = (method: string, url: string): boolean => {
    if (url === "/api/health") return true;
    if (url.startsWith("/api/tracking/") && method === "GET") return true;
    if (url === "/api/auth/login" || url === "/api/auth/refresh") return true;
    // public customer-facing endpoints (rate limited)
    if (url === "/api/delivery-requests" && method === "POST") return true;
    if (url === "/api/quotes/public" && method === "POST") return true;
    if (url === "/api/geo/geocode" && method === "POST") return true;
    if (url === "/api/geo/reverse" && method === "POST") return true;
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

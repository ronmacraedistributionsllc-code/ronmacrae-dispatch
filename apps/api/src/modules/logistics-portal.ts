import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { verifyPassword } from "../lib/password.js";
import { normalizeEmail } from "../lib/email.js";
import { ACTIVE_JOB_STATUSES } from "@ronmacrae/contracts";
import { resolveStaffContext, toUserDto } from "./auth.js";
import { listLogisticsRiderThread, listOwnerUserThread, sendLogisticsRiderMessage, sendOwnerUserMessage, SendPlatformMessageBody } from "./platform-messages.js";

/**
 * A logistics/bearer company's own login (spec: "Bearer/Logistics Company
 * portal with fleet dashboard") — its own auth "face", same pattern as
 * merchant-portal.ts: a distinct JWT type (jwt.ts's logistics_portal),
 * verified per-route via requireLogisticsAuth below rather than a global
 * preHandler. Scoped to exactly one LogisticsCompany — never a whole
 * Business, never another company's riders.
 *
 * What this portal can see is deliberately read-only: which of ITS riders
 * (Rider.attachedLogisticsCompanyId) are active, their live status, and how
 * loaded they are right now. Attaching/detaching a rider to a company at
 * all is a Platform Admin decision (see platform-admin.ts's rider PATCH),
 * not something a logistics company grants itself — same "the vouching is
 * someone else's call" rule as merchant/staff account creation.
 */

const LoginBody = z.object({
  email: z.string().email().max(160),
  password: z.string().min(1).max(128),
});

interface LogisticsAuth {
  userId: string;
  logisticsCompanyId: string;
}

async function requireLogisticsAuth(ctx: AppCtx, req: FastifyRequest): Promise<LogisticsAuth> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw httpErrors.createError(401, "Sign in to the logistics portal first.");
  const payload = await ctx.jwt.verifyLogisticsPortal(token);
  if (!payload) throw httpErrors.createError(401, "Your session has expired — sign in again.");
  return { userId: payload.sub, logisticsCompanyId: payload.logisticsCompanyId };
}

interface FleetRiderDto {
  id: string;
  name: string;
  phone: string;
  vehicle: string;
  status: string;
  active: boolean;
  platformStatus: string;
  dailyCapacity: number;
  activeJobCount: number;
}

export async function logisticsPortalRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post("/api/logistics-portal/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const body = LoginBody.parse(req.body);
    const email = normalizeEmail(body.email);
    const genericError = () => httpErrors.createError(401, "Incorrect email or password.");
    if (!email) throw genericError();
    const user = await ctx.prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(body.password, user.passwordHash)) throw genericError();
    // See merchant-portal.ts's matching login route for the full
    // rationale — a platform-level delete/disable must block every login
    // face this shared User can reach, not just the unified staff route.
    if (user.deletedAt || !user.active) throw genericError();
    const membership = await ctx.prisma.logisticsCompanyStaff.findFirst({
      where: { userId: user.id, active: true },
      include: { logisticsCompany: { select: { id: true, name: true, active: true } } },
    });
    if (!membership || !membership.logisticsCompany.active) throw httpErrors.createError(403, "This account has no active logistics company access.");
    const token = await ctx.jwt.issueLogisticsPortal(user.id, membership.logisticsCompanyId);
    await ctx.audit.record({ id: user.id, role: "logistics" }, "logistics_portal.login", "logistics_company", membership.logisticsCompanyId);
    return { token, logisticsCompany: { id: membership.logisticsCompany.id, name: membership.logisticsCompany.name }, user: { name: user.name, email: user.email } };
  });

  app.get("/api/logistics-portal/me", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const company = await ctx.prisma.logisticsCompany.findUniqueOrThrow({ where: { id: auth.logisticsCompanyId } });
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, role: true, platformRole: true } });
    const staffContext = await resolveStaffContext(ctx, user);
    return { logisticsCompany: { id: company.id, name: company.name, active: company.active }, hasStaffAccess: staffContext !== null };
  });

  // The reverse of /api/auth/switch-to-logistics — same rationale/shape as
  // merchant-portal.ts's switch-to-staff: access-token-only, no refresh
  // cookie, ~15min session.
  app.post("/api/logistics-portal/switch-to-staff", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { rider: { select: { id: true } } } });
    const staffContext = await resolveStaffContext(ctx, user);
    if (!staffContext) throw httpErrors.createError(403, "This account has no staff or courier access to switch to.");
    const accessToken = await ctx.jwt.issueAccess({
      id: user.id,
      name: user.name,
      role: staffContext.role,
      riderId: user.rider?.id,
      businessId: staffContext.businessId ?? undefined,
      platformRole: staffContext.platformRole ?? undefined,
    });
    await ctx.audit.record({ id: user.id, role: staffContext.role }, "auth.switch_workspace", "user", user.id);
    return { accessToken, user: toUserDto(user), businessId: staffContext.businessId, platformRole: staffContext.platformRole };
  });

  // "Message the owner" (spec: "admin-to-anyone") — see platform-messages.ts.
  app.get("/api/logistics-portal/messages/owner", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    return listOwnerUserThread(ctx, auth.userId, "user", auth.userId, true);
  });

  app.post("/api/logistics-portal/messages/owner", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const body = SendPlatformMessageBody.parse(req.body);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    await sendOwnerUserMessage(ctx, auth.userId, "user", auth.userId, user.name, body.body);
    return listOwnerUserThread(ctx, auth.userId, "user", auth.userId, true);
  });

  // Fleet messaging (spec: "logistics<->riders") — only a rider actually
  // attached to this company; see the Rider's own /api/bearer/logistics-
  // messages equivalent in bearer.ts.
  app.get<{ Params: { riderId: string } }>("/api/logistics-portal/riders/:riderId/messages", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const rider = await ctx.prisma.rider.findFirst({ where: { id: req.params.riderId, attachedLogisticsCompanyId: auth.logisticsCompanyId } });
    if (!rider) throw httpErrors.createError(404, "Courier not found");
    return listLogisticsRiderThread(ctx, auth.logisticsCompanyId, rider.id, "logistics", auth.userId, true);
  });

  app.post<{ Params: { riderId: string } }>("/api/logistics-portal/riders/:riderId/messages", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const rider = await ctx.prisma.rider.findFirst({ where: { id: req.params.riderId, attachedLogisticsCompanyId: auth.logisticsCompanyId } });
    if (!rider) throw httpErrors.createError(404, "Courier not found");
    const body = SendPlatformMessageBody.parse(req.body);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    await sendLogisticsRiderMessage(ctx, auth.logisticsCompanyId, rider.id, "logistics", auth.userId, user.name, body.body);
    return listLogisticsRiderThread(ctx, auth.logisticsCompanyId, rider.id, "logistics", auth.userId, true);
  });

  // Fleet dashboard — every rider Platform Admin has attached to this
  // company (Rider.attachedLogisticsCompanyId), with live status/capacity.
  // Read-only: attachment itself is Platform Admin's call, not this portal's.
  app.get("/api/logistics-portal/riders", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const riders = await ctx.prisma.rider.findMany({
      where: { attachedLogisticsCompanyId: auth.logisticsCompanyId },
      orderBy: { name: "asc" },
    });
    const dtos: FleetRiderDto[] = await Promise.all(
      riders.map(async (r) => {
        const activeJobCount = await ctx.prisma.job.count({ where: { riderId: r.id, status: { in: [...ACTIVE_JOB_STATUSES] } } });
        return {
          id: r.id,
          name: r.name,
          phone: r.phone,
          vehicle: r.vehicle,
          status: r.status,
          active: r.active,
          platformStatus: r.platformStatus,
          dailyCapacity: r.dailyCapacity,
          activeJobCount,
        };
      }),
    );
    return { riders: dtos };
  });
}

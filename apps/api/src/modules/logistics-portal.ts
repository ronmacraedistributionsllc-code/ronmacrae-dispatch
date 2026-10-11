import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { verifyPassword } from "../lib/password.js";
import { normalizeEmail } from "../lib/email.js";
import { ACTIVE_JOB_STATUSES } from "@ronmacrae/contracts";
import type { LogisticsFleetJobDto } from "@ronmacrae/contracts";
import { normalizePhone, resolveStaffContext, toUserDto } from "./auth.js";
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

  /**
   * Add one of YOUR OWN bearers: creates the rider attached to this
   * company (attachment logistics, pending platform vetting) plus a
   * pending membership at the parent business for that business's admin
   * to approve. This is how "their bearers work for them only" starts —
   * the company proposes, the business approves the membership, the
   * platform approves the person. An existing rider already attached
   * elsewhere is refused (only Platform Admin moves riders between
   * companies); an unattached existing rider is attached in place.
   */
  app.post("/api/logistics-portal/riders", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const body = z
      .object({
        name: z.string().min(1).max(120),
        phone: z.string().min(7).max(20),
        vehicle: z.enum(["motorcycle", "car"]).default("motorcycle"),
        plate: z.string().max(20).optional().or(z.literal("")).nullable(),
      })
      .parse(req.body);
    const company = await ctx.prisma.logisticsCompany.findUniqueOrThrow({ where: { id: auth.logisticsCompanyId } });
    if (!company.active) throw httpErrors.createError(403, "Your company is disabled — contact Platform Admin.");
    const phone = normalizePhone(body.phone);
    const existing = await ctx.prisma.rider.findUnique({ where: { phone } });
    if (existing?.attachedLogisticsCompanyId && existing.attachedLogisticsCompanyId !== company.id) {
      throw httpErrors.createError(409, "That courier already works for another company — only Platform Admin can move them.");
    }
    let riderId: string;
    if (existing) {
      await ctx.prisma.rider.update({ where: { id: existing.id }, data: { attachment: "logistics", attachedLogisticsCompanyId: company.id } });
      riderId = existing.id;
    } else {
      const rider = await ctx.prisma.rider.create({
        data: {
          name: body.name,
          phone,
          vehicle: body.vehicle as "motorcycle" | "car",
          plate: body.plate || null,
          dailyCapacity: 5,
          status: "available",
          active: true,
          platformStatus: "pending",
          attachment: "logistics",
          attachedLogisticsCompanyId: company.id,
          selfSignedUp: false,
        },
      });
      riderId = rider.id;
    }
    await ctx.prisma.riderMembership.upsert({
      where: { riderId_businessId: { riderId, businessId: company.businessId } },
      create: { riderId, businessId: company.businessId, status: "pending" },
      update: {},
    });
    await ctx.audit.record({ id: auth.userId, role: "logistics" }, "logistics.rider.add", "rider", riderId, { logisticsCompanyId: company.id });
    return { riderId };
  });

  /**
   * Release one of your bearers: detaches them back to freelance (they
   * keep their account, memberships, and history — they just stop being
   * YOUR fleet). Refuses while they're carrying live work.
   */
  app.post<{ Params: { riderId: string } }>("/api/logistics-portal/riders/:riderId/detach", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const rider = await ctx.prisma.rider.findFirst({ where: { id: req.params.riderId, attachedLogisticsCompanyId: auth.logisticsCompanyId } });
    if (!rider) throw httpErrors.createError(404, "Courier not found in your fleet");
    const carrying = await ctx.prisma.job.count({ where: { riderId: rider.id, status: { in: [...ACTIVE_JOB_STATUSES] } } });
    if (carrying > 0) throw httpErrors.createError(409, "They're still carrying live work — detach after they finish.");
    await ctx.prisma.rider.update({ where: { id: rider.id }, data: { attachedLogisticsCompanyId: null, attachment: "freelance" } });
    await ctx.audit.record({ id: auth.userId, role: "logistics" }, "logistics.rider.detach", "rider", rider.id, { logisticsCompanyId: auth.logisticsCompanyId });
    return { ok: true };
  });

  // Fleet dashboard — every rider Platform Admin has attached to this
  // company (Rider.attachedLogisticsCompanyId), with live status/capacity.
  // Attachment itself used to be Platform Admin's call only; companies can
  // now add (propose) and detach their own fleet above — moving a rider
  // BETWEEN companies stays Platform Admin's call.
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

  /**
   * Unassigned work at the parent business this company can fill: `new`,
   * riderless jobs, deliberately narrow (same privacy rule as the fleet
   * jobs below — no customer name/phone/exact address, just enough to
   * choose who should take it: what, where-about, payout, pay method).
   */
  app.get("/api/logistics-portal/jobs", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const company = await ctx.prisma.logisticsCompany.findUniqueOrThrow({ where: { id: auth.logisticsCompanyId } });
    const jobs = await ctx.prisma.job.findMany({
      where: { businessId: company.businessId, status: "new", riderId: null, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { zone: { select: { name: true } }, merchant: { select: { name: true } } },
    });
    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        jobNumber: j.jobNumber,
        itemSummary: j.itemSummary,
        zoneName: j.zone?.name ?? null,
        merchantName: j.merchant?.name ?? null,
        paymentMethod: j.paymentMethod,
        createdAt: j.createdAt.toISOString(),
      })),
    };
  });

  /**
   * Who this company may send work to: its own attached bearers ("fleet",
   * direct-assignable) plus the open pool ("pool" — approved, self-signed,
   * open-network couriers who don't regularly deliver here, offered — not
   * assigned — so they keep choosing who they work for). Cash jobs additionally
   * require verification; the assign/offer routes enforce it, and the flag
   * ships here so the picker can say so upfront.
   */
  app.get("/api/logistics-portal/couriers", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const company = await ctx.prisma.logisticsCompany.findUniqueOrThrow({ where: { id: auth.logisticsCompanyId } });
    if (!company.active) throw httpErrors.createError(403, "Your company is disabled — contact Platform Admin.");
    const { eligibleRiders, dispatchPool } = await import("./offers.js");
    const { pool } = await dispatchPool(ctx, company.businessId);
    const withLoad = async (r: { id: string }) =>
      await ctx.prisma.job.count({ where: { riderId: r.id, status: { in: [...ACTIVE_JOB_STATUSES] } } });
    const fleetRows = await ctx.prisma.rider.findMany({ where: { attachedLogisticsCompanyId: company.id, active: true } });
    const fleet = await Promise.all(
      fleetRows.map(async (r) => ({
        id: r.id, name: r.name, phone: r.phone, vehicle: r.vehicle,
        dailyCapacity: r.dailyCapacity, verified: r.verified, activeJobCount: await withLoad(r),
      })),
    );
    // Open pool: eligible non-members. Phones stay hidden until they
    // accept — first contact is the offer itself (push + their app), so
    // nobody gets cold-called for work they never chose.
    const poolEligible = pool === "company" ? [] : await eligibleRiders(ctx, company.businessId, null, undefined, pool, undefined);
    const poolChecks = await Promise.all(
      poolEligible.map(async (r) => ({
        r,
        member: await ctx.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId: r.id, businessId: company.businessId } } }),
      })),
    );
    const poolOut = await Promise.all(
      poolChecks
        .filter(({ member }) => !member || member.status !== "active")
        .map(async ({ r }) => ({
          id: r.id, name: r.name, vehicle: r.vehicle,
          dailyCapacity: r.dailyCapacity, verified: r.verified, activeJobCount: await withLoad(r),
        })),
    );
    return { fleet, pool: poolOut };
  });

  /**
   * Assign one of YOUR OWN bearers, directly: the rider must be attached
   * to this company (fleet list above). Reuses the staff assign engine,
   * so membership, capacity, and cash-verification all still apply — a
   * pending-membership bearer can't be assigned until their business
   * approves them. Returns ids only, never the customer-facing dto.
   */
  app.post<{ Params: { id: string } }>("/api/logistics-portal/jobs/:id/assign", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const body = z.object({ riderId: z.string().min(1) }).parse(req.body);
    const company = await ctx.prisma.logisticsCompany.findUniqueOrThrow({ where: { id: auth.logisticsCompanyId } });
    if (!company.active) throw httpErrors.createError(403, "Your company is disabled — contact Platform Admin.");
    const job = await ctx.prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job || job.businessId !== company.businessId || job.status !== "new" || job.riderId || job.deletedAt) {
      throw httpErrors.createError(409, "That job is no longer assignable");
    }
    const rider = await ctx.prisma.rider.findFirst({ where: { id: body.riderId, attachedLogisticsCompanyId: company.id } });
    if (!rider) throw httpErrors.createError(404, "That courier isn't in your fleet — offer them from the pool instead");
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const { assignJob } = await import("./jobs/assign.js");
    await assignJob(
      ctx,
      job.id,
      { riderId: rider.id, reason: "fleet assign" },
      { id: auth.userId, name: user.name, role: "logistics", riderId: null, businessId: company.businessId },
      { role: "logistics", businessId: company.businessId },
    );
    await ctx.audit.record({ id: auth.userId, role: "logistics" }, "logistics.job.assign", "job", job.id, { riderId: rider.id, logisticsCompanyId: company.id });
    return { ok: true, jobId: job.id, riderId: rider.id };
  });

  /**
   * Offer an unassigned job to an open-pool courier: they choose by
   * accepting (or ignoring) — the company never force-assigns a stranger.
   * Accepts only riders the eligibility engine clears for THIS job
   * (membership/free-roam, verified-for-cash, capacity), so the pool
   * picker can't be used to bypass any rule.
   */
  app.post<{ Params: { id: string } }>("/api/logistics-portal/jobs/:id/offer", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const body = z.object({ riderId: z.string().min(1) }).parse(req.body);
    const company = await ctx.prisma.logisticsCompany.findUniqueOrThrow({ where: { id: auth.logisticsCompanyId } });
    if (!company.active) throw httpErrors.createError(403, "Your company is disabled — contact Platform Admin.");
    const job = await ctx.prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job || job.businessId !== company.businessId || job.status !== "new" || job.riderId || job.deletedAt) {
      throw httpErrors.createError(409, "That job is no longer offerable");
    }
    const { eligibleRiders, createOffers, dispatchPool } = await import("./offers.js");
    const { pool, expiryMinutes } = await dispatchPool(ctx, company.businessId);
    const eligible = await eligibleRiders(ctx, company.businessId, job.merchantId, [body.riderId], pool, job.paymentMethod);
    if (!eligible.some((r) => r.id === body.riderId)) {
      throw httpErrors.createError(409, "That courier isn't eligible for this job (membership, verification, or capacity) — try another.");
    }
    const expiresAt = new Date(Date.now() + expiryMinutes * 60_000);
    const offers = await createOffers(ctx, job.id, company.businessId, [{ id: body.riderId }], expiresAt);
    await ctx.audit.record({ id: auth.userId, role: "logistics" }, "logistics.job.offer", "job", job.id, { riderId: body.riderId, logisticsCompanyId: company.id });
    return { ok: true, offerId: offers[0]!.id };
  });

  // Spec: "logistics-company dashboard" — what one of this company's own
  // riders is actually delivering right now (plus a little recent history),
  // not just their idle/available status. Deliberately narrow (see
  // LogisticsFleetJobDto's own doc comment): this company supplies the
  // courier, it doesn't own the dispatching business's customer
  // relationship, so no customer name/phone/exact address ships here —
  // only what a fleet manager actually needs.
  app.get<{ Params: { riderId: string } }>("/api/logistics-portal/riders/:riderId/jobs", async (req) => {
    const auth = await requireLogisticsAuth(ctx, req);
    const rider = await ctx.prisma.rider.findFirst({ where: { id: req.params.riderId, attachedLogisticsCompanyId: auth.logisticsCompanyId } });
    if (!rider) throw httpErrors.createError(404, "Courier not found");
    const jobs = await ctx.prisma.job.findMany({
      where: { riderId: rider.id },
      include: { zone: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const dtos: LogisticsFleetJobDto[] = jobs.map((j) => ({
      id: j.id,
      jobNumber: j.jobNumber,
      status: j.status,
      itemSummary: j.itemSummary,
      zoneName: j.zone?.name ?? null,
      scheduledAt: j.scheduledAt?.toISOString() ?? null,
      completedAt: j.completedAt?.toISOString() ?? null,
      createdAt: j.createdAt.toISOString(),
    }));
    return { jobs: dtos };
  });
}

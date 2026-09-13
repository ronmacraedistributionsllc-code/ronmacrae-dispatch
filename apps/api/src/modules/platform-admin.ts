import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { buildRiderCashProfile } from "./cash-profile.js";

/**
 * The platform-owner console (spec: "Build or complete the real Platform
 * Admin portal. I must be able to search, inspect, approve, block,
 * disable, archive, reactivate, and manage every registered business and
 * person"). Everything here is gated by `ctx.requireOwner` — the SAME
 * `platformRole: "owner"` concept owner.ts already established (Stage 23,
 * customer-identity duplicate resolution) — deliberately not a new auth
 * "face": an owner is a staff/rider login that also happens to carry this
 * flag, so their existing session already works here.
 *
 * Scoped honestly to what this app actually has today: real business/
 * merchant/rider/staff records, real job history, real cash figures (via
 * the existing cash-profile service). Ratings, admin-to-anyone messaging,
 * and per-person shortage/dispute rollups are NOT built here — this app
 * has no ratings system and no owner-to-user messaging yet; faking those
 * sections would be worse than omitting them.
 */

const businessName = { select: { id: true, name: true } } as const;

function requireQuery(raw: unknown) {
  return z.object({ q: z.string().max(120).optional() }).parse(raw ?? {});
}

export async function platformAdminRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const owner = ctx.requireOwner;

  // ---------------------------------------------------------------------
  // Businesses
  // ---------------------------------------------------------------------
  app.get("/api/platform/businesses", { preHandler: owner }, async (req) => {
    const { q } = requireQuery(req.query);
    const rows = await ctx.prisma.business.findMany({
      where: q ? { name: { contains: q } } : undefined,
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { merchants: true, staffMemberships: true, riderMemberships: true, jobs: true } } },
    });
    return {
      businesses: rows.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        active: b.active,
        createdAt: b.createdAt.toISOString(),
        merchantCount: b._count.merchants,
        staffCount: b._count.staffMemberships,
        riderCount: b._count.riderMemberships,
        jobCount: b._count.jobs,
      })),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/platform/businesses/:id", { preHandler: owner }, async (req) => {
    const body = z.object({ active: z.boolean() }).parse(req.body);
    const business = await ctx.prisma.business.update({ where: { id: req.params.id }, data: { active: body.active } });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, body.active ? "platform.business.reactivate" : "platform.business.disable", "business", business.id);
    return { ok: true, active: business.active };
  });

  // ---------------------------------------------------------------------
  // Merchants — across every business, not just the caller's own.
  // ---------------------------------------------------------------------
  app.get("/api/platform/merchants", { preHandler: owner }, async (req) => {
    const { q } = requireQuery(req.query);
    const rows = await ctx.prisma.merchant.findMany({
      where: q ? { name: { contains: q } } : undefined,
      orderBy: { createdAt: "desc" },
      include: { business: businessName, _count: { select: { jobs: true, products: true, staff: true } } },
    });
    return {
      merchants: rows.map((m) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        active: m.active,
        business: m.business,
        jobCount: m._count.jobs,
        productCount: m._count.products,
        staffCount: m._count.staff,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/platform/merchants/:id", { preHandler: owner }, async (req) => {
    const body = z.object({ active: z.boolean() }).parse(req.body);
    const merchant = await ctx.prisma.merchant.update({ where: { id: req.params.id }, data: { active: body.active } });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, body.active ? "platform.merchant.reactivate" : "platform.merchant.disable", "merchant", merchant.id);
    return { ok: true, active: merchant.active };
  });

  // ---------------------------------------------------------------------
  // Riders — platform-wide approval/blocking (spec: "Platform Admin
  // controls whether a rider is freelancer/platform-approved... or
  // disabled/blocked"), across every business a rider is a member of.
  // ---------------------------------------------------------------------
  app.get("/api/platform/riders", { preHandler: owner }, async (req) => {
    const { q } = requireQuery(req.query);
    const rows = await ctx.prisma.rider.findMany({
      where: q ? { OR: [{ name: { contains: q } }, { phone: { contains: q } }] } : undefined,
      orderBy: { createdAt: "desc" },
      include: { memberships: { include: { business: businessName } } },
    });
    return {
      riders: rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        vehicle: r.vehicle,
        active: r.active,
        platformStatus: r.platformStatus,
        status: r.status,
        memberships: r.memberships.map((m) => ({ businessId: m.businessId, businessName: m.business.name, status: m.status })),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/platform/riders/:id", { preHandler: owner }, async (req) => {
    const rider = await ctx.prisma.rider.findUnique({
      where: { id: req.params.id },
      include: { memberships: { include: { business: businessName } }, user: { select: { email: true, phone: true, emailVerifiedAt: true, active: true } } },
    });
    if (!rider) throw httpErrors.createError(404, "Rider not found");
    const statusCounts = await ctx.prisma.job.groupBy({ by: ["status"], where: { riderId: rider.id }, _count: true });
    // A rider can be a member of more than one business — an honest
    // aggregate needs the cash profile across all of them, not just one.
    const businessIds = rider.memberships.map((m) => m.businessId);
    const cashByBusiness = await Promise.all(
      businessIds.map(async (businessId) => ({ businessId, profile: await buildRiderCashProfile(ctx, rider.id, [businessId]) })),
    );
    return {
      rider: {
        id: rider.id,
        name: rider.name,
        phone: rider.phone,
        vehicle: rider.vehicle,
        active: rider.active,
        platformStatus: rider.platformStatus,
        status: rider.status,
        email: rider.user?.email ?? null,
        emailVerified: rider.user?.emailVerifiedAt != null,
        loginActive: rider.user?.active ?? null,
        memberships: rider.memberships.map((m) => ({ businessId: m.businessId, businessName: m.business.name, status: m.status, approvedAt: m.approvedAt?.toISOString() ?? null })),
        jobsByStatus: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])),
        cashByBusiness: cashByBusiness.map((c) => ({ businessId: c.businessId, businessName: rider.memberships.find((m) => m.businessId === c.businessId)?.business.name ?? "", ...c.profile })),
      },
      // Not built yet — see this module's own doc comment. Present as an
      // explicit, honest empty section rather than omitted entirely, so
      // the frontend can show "not yet available" instead of nothing.
      ratings: null,
    };
  });

  app.patch<{ Params: { id: string } }>("/api/platform/riders/:id", { preHandler: owner }, async (req) => {
    const body = z
      .object({
        platformStatus: z.enum(["pending", "approved", "suspended"]).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.platformStatus === undefined && body.active === undefined) throw httpErrors.createError(400, "Nothing to update");
    const rider = await ctx.prisma.rider.update({
      where: { id: req.params.id },
      data: { platformStatus: body.platformStatus, active: body.active },
    });
    await ctx.audit.record(
      { id: req.user!.sub, role: "platform_owner" },
      "platform.rider.update",
      "rider",
      rider.id,
      { platformStatus: body.platformStatus, active: body.active },
    );
    return { ok: true, platformStatus: rider.platformStatus, active: rider.active };
  });

  // ---------------------------------------------------------------------
  // Staff & merchant-staff — every login on the platform, not just one
  // business's own Team screen.
  // ---------------------------------------------------------------------
  app.get("/api/platform/staff", { preHandler: owner }, async (req) => {
    const { q } = requireQuery(req.query);
    const rows = await ctx.prisma.user.findMany({
      where: {
        role: { not: "rider" },
        ...(q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        staffMemberships: { include: { business: businessName } },
        merchantStaffMemberships: { include: { merchant: { select: { id: true, name: true } } } },
      },
    });
    return {
      staff: rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        active: u.active,
        platformRole: u.platformRole,
        businesses: u.staffMemberships.map((m) => ({ id: m.businessId, name: m.business.name, role: m.role, active: m.active })),
        merchants: u.merchantStaffMemberships.map((m) => ({ id: m.merchantId, name: m.merchant.name, active: m.active })),
        createdAt: u.createdAt.toISOString(),
      })),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/platform/users/:id", { preHandler: owner }, async (req) => {
    const body = z.object({ active: z.boolean() }).parse(req.body);
    if (req.params.id === req.user!.sub && !body.active) {
      throw httpErrors.createError(400, "You can't disable your own account.");
    }
    const user = await ctx.prisma.user.update({ where: { id: req.params.id }, data: { active: body.active } });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, body.active ? "platform.user.reactivate" : "platform.user.disable", "user", user.id);
    return { ok: true, active: user.active };
  });

  // ---------------------------------------------------------------------
  // Platform-wide audit log — every business's, unlike the existing
  // business-scoped GET /api/audit.
  // ---------------------------------------------------------------------
  app.get("/api/platform/audit", { preHandler: owner }, async (req) => {
    const q = z
      .object({
        take: z.coerce.number().int().min(1).max(200).default(50),
        skip: z.coerce.number().int().min(0).default(0),
        action: z.string().max(80).optional(),
        entityType: z.string().max(40).optional(),
      })
      .parse(req.query);
    const where = {
      ...(q.action ? { action: { contains: q.action } } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
    };
    const [logs, total] = await Promise.all([
      ctx.prisma.auditLog.findMany({ where, orderBy: { at: "desc" }, take: q.take, skip: q.skip, include: { user: { select: { name: true, email: true } } } }),
      ctx.prisma.auditLog.count({ where }),
    ]);
    return {
      total,
      logs: logs.map((l) => ({
        id: l.id,
        userName: l.user?.name ?? null,
        userEmail: l.user?.email ?? null,
        role: l.role,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId,
        createdAt: l.at.toISOString(),
      })),
    };
  });
}

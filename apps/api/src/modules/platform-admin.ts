import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { buildRiderCashProfile } from "./cash-profile.js";
import { resolveStaffContext, toUserDto } from "./auth.js";

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

const ReviewBody = z.object({
  decision: z.enum(["approve", "reject"]),
  /** Required for a rejection (spec: distinct rejected state, with a
   *  reason Platform Admin can see later) — never shown to the applicant
   *  over email, only in this console. */
  reason: z.string().max(500).optional(),
});

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
      include: { _count: { select: { merchants: true, logisticsCompanies: true, staffMemberships: true, riderMemberships: true, jobs: true } } },
    });
    return {
      businesses: rows.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        active: b.active,
        createdAt: b.createdAt.toISOString(),
        merchantCount: b._count.merchants,
        logisticsCompanyCount: b._count.logisticsCompanies,
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
      include: { business: businessName, reviewedBy: { select: { name: true } }, _count: { select: { jobs: true, products: true, staff: true } } },
    });
    return {
      merchants: rows.map((m) => ({
        id: m.id,
        name: m.name,
        slug: m.slug,
        email: m.email,
        active: m.active,
        applicationStatus: m.applicationStatus,
        rejectionReason: m.rejectionReason,
        reviewedAt: m.reviewedAt?.toISOString() ?? null,
        reviewedByName: m.reviewedBy?.name ?? null,
        business: m.business,
        jobCount: m._count.jobs,
        productCount: m._count.products,
        staffCount: m._count.staff,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  });

  // Approve or reject a *pending* self-signup application — distinct from
  // the plain active-toggle below, which is disable/reactivate for a
  // merchant that's already been through this step (spec: four separate
  // verbs — approve/reject/disable/reactivate — not one boolean).
  app.post<{ Params: { id: string } }>("/api/platform/merchants/:id/review", { preHandler: owner }, async (req) => {
    const body = ReviewBody.parse(req.body);
    const existing = await ctx.prisma.merchant.findUnique({ where: { id: req.params.id } });
    if (!existing) throw httpErrors.createError(404, "Merchant not found");
    if (existing.applicationStatus !== "pending") {
      throw httpErrors.createError(409, "This application has already been reviewed — use disable/reactivate instead.");
    }
    if (body.decision === "reject" && !body.reason?.trim()) {
      throw httpErrors.createError(400, "A rejection reason is required.");
    }
    const merchant = await ctx.prisma.merchant.update({
      where: { id: existing.id },
      data: {
        applicationStatus: body.decision === "approve" ? "approved" : "rejected",
        active: body.decision === "approve",
        rejectionReason: body.decision === "reject" ? body.reason!.trim() : null,
        reviewedAt: new Date(),
        reviewedById: req.user!.sub,
      },
    });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, `platform.merchant.${body.decision}`, "merchant", merchant.id, { reason: body.reason ?? null });
    return { ok: true, applicationStatus: merchant.applicationStatus, active: merchant.active };
  });

  app.patch<{ Params: { id: string } }>("/api/platform/merchants/:id", { preHandler: owner }, async (req) => {
    const body = z.object({ active: z.boolean() }).parse(req.body);
    const existing = await ctx.prisma.merchant.findUnique({ where: { id: req.params.id } });
    if (!existing) throw httpErrors.createError(404, "Merchant not found");
    if (existing.applicationStatus === "pending") {
      throw httpErrors.createError(400, "This application hasn't been reviewed yet — approve or reject it first.");
    }
    const merchant = await ctx.prisma.merchant.update({ where: { id: req.params.id }, data: { active: body.active } });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, body.active ? "platform.merchant.reactivate" : "platform.merchant.disable", "merchant", merchant.id);
    return { ok: true, active: merchant.active };
  });

  // ---------------------------------------------------------------------
  // Logistics companies — across every business, mirrors merchants above.
  // ---------------------------------------------------------------------
  app.get("/api/platform/logistics-companies", { preHandler: owner }, async (req) => {
    const { q } = requireQuery(req.query);
    const rows = await ctx.prisma.logisticsCompany.findMany({
      where: q ? { name: { contains: q } } : undefined,
      orderBy: { createdAt: "desc" },
      include: { business: businessName, reviewedBy: { select: { name: true } }, _count: { select: { riders: true, staff: true } } },
    });
    return {
      logisticsCompanies: rows.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        email: c.email,
        active: c.active,
        applicationStatus: c.applicationStatus,
        rejectionReason: c.rejectionReason,
        reviewedAt: c.reviewedAt?.toISOString() ?? null,
        reviewedByName: c.reviewedBy?.name ?? null,
        business: c.business,
        riderCount: c._count.riders,
        staffCount: c._count.staff,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  });

  // Approve or reject a *pending* self-signup application — see the
  // matching merchant endpoint above for the full rationale.
  app.post<{ Params: { id: string } }>("/api/platform/logistics-companies/:id/review", { preHandler: owner }, async (req) => {
    const body = ReviewBody.parse(req.body);
    const existing = await ctx.prisma.logisticsCompany.findUnique({ where: { id: req.params.id } });
    if (!existing) throw httpErrors.createError(404, "Logistics company not found");
    if (existing.applicationStatus !== "pending") {
      throw httpErrors.createError(409, "This application has already been reviewed — use disable/reactivate instead.");
    }
    if (body.decision === "reject" && !body.reason?.trim()) {
      throw httpErrors.createError(400, "A rejection reason is required.");
    }
    const company = await ctx.prisma.logisticsCompany.update({
      where: { id: existing.id },
      data: {
        applicationStatus: body.decision === "approve" ? "approved" : "rejected",
        active: body.decision === "approve",
        rejectionReason: body.decision === "reject" ? body.reason!.trim() : null,
        reviewedAt: new Date(),
        reviewedById: req.user!.sub,
      },
    });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, `platform.logistics_company.${body.decision}`, "logistics_company", company.id, { reason: body.reason ?? null });
    return { ok: true, applicationStatus: company.applicationStatus, active: company.active };
  });

  app.patch<{ Params: { id: string } }>("/api/platform/logistics-companies/:id", { preHandler: owner }, async (req) => {
    const body = z.object({ active: z.boolean() }).parse(req.body);
    const existing = await ctx.prisma.logisticsCompany.findUnique({ where: { id: req.params.id } });
    if (!existing) throw httpErrors.createError(404, "Logistics company not found");
    if (existing.applicationStatus === "pending") {
      throw httpErrors.createError(400, "This application hasn't been reviewed yet — approve or reject it first.");
    }
    const company = await ctx.prisma.logisticsCompany.update({ where: { id: req.params.id }, data: { active: body.active } });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, body.active ? "platform.logistics_company.reactivate" : "platform.logistics_company.disable", "logistics_company", company.id);
    return { ok: true, active: company.active };
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
      include: {
        memberships: { include: { business: businessName } },
        attachedMerchant: businessName,
        attachedLogisticsCompany: businessName,
        merchantRiders: { where: { status: "active" }, include: { merchant: businessName } },
        user: { select: { email: true, active: true, deletedAt: true } },
      },
    });
    return {
      riders: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        name: r.name,
        phone: r.phone,
        email: r.user?.email ?? null,
        vehicle: r.vehicle,
        active: r.active,
        // A courier's own platform-account state (User.active/deletedAt)
        // is distinct from Rider.active/platformStatus above — a rider
        // can be deleted at the account level (can never log in again)
        // while the Rider profile row itself, and every job it's
        // attached to, stays fully intact for history.
        accountDeleted: r.user?.deletedAt != null,
        accountActive: r.user?.active ?? null,
        platformStatus: r.platformStatus,
        status: r.status,
        attachment: r.attachment,
        attachedMerchant: r.attachedMerchant ? { id: r.attachedMerchant.id, name: r.attachedMerchant.name } : null,
        attachedLogisticsCompany: r.attachedLogisticsCompany ? { id: r.attachedLogisticsCompany.id, name: r.attachedLogisticsCompany.name } : null,
        memberships: r.memberships.map((m) => ({ businessId: m.businessId, businessName: m.business.name, status: m.status })),
        merchants: r.merchantRiders.map((m) => ({ merchantId: m.merchantId, merchantName: m.merchant.name, status: m.status, addedAt: m.createdAt.toISOString() })),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/platform/riders/:id", { preHandler: owner }, async (req) => {
    const rider = await ctx.prisma.rider.findUnique({
      where: { id: req.params.id },
      include: {
        memberships: { include: { business: businessName } },
        user: { select: { email: true, phone: true, emailVerifiedAt: true, active: true } },
        attachedMerchant: businessName,
        attachedLogisticsCompany: businessName,
        merchantRiders: { where: { status: "active" }, include: { merchant: businessName } },
      },
    });
    if (!rider) throw httpErrors.createError(404, "Courier not found");
    const statusCounts = await ctx.prisma.job.groupBy({ by: ["status"], where: { riderId: rider.id }, _count: true });
    const visibleRatings = await ctx.prisma.rating.findMany({ where: { riderId: rider.id, hidden: false }, orderBy: { createdAt: "desc" }, take: 20 });
    const ratingAgg = await ctx.prisma.rating.aggregate({ where: { riderId: rider.id, hidden: false }, _avg: { score: true }, _count: true });
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
        attachment: rider.attachment,
        attachedMerchant: rider.attachedMerchant ? { id: rider.attachedMerchant.id, name: rider.attachedMerchant.name } : null,
        attachedLogisticsCompany: rider.attachedLogisticsCompany ? { id: rider.attachedLogisticsCompany.id, name: rider.attachedLogisticsCompany.name } : null,
        email: rider.user?.email ?? null,
        emailVerified: rider.user?.emailVerifiedAt != null,
        loginActive: rider.user?.active ?? null,
        memberships: rider.memberships.map((m) => ({ businessId: m.businessId, businessName: m.business.name, status: m.status, approvedAt: m.approvedAt?.toISOString() ?? null })),
        merchants: rider.merchantRiders.map((m) => ({ merchantId: m.merchantId, merchantName: m.merchant.name, status: m.status, addedAt: m.createdAt.toISOString() })),
        jobsByStatus: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])),
        cashByBusiness: cashByBusiness.map((c) => ({ businessId: c.businessId, businessName: rider.memberships.find((m) => m.businessId === c.businessId)?.business.name ?? "", ...c.profile })),
      },
      ratings: {
        average: ratingAgg._avg.score,
        count: ratingAgg._count,
        recent: visibleRatings.map((r) => ({ id: r.id, jobId: r.jobId, raterType: r.raterType, score: r.score, comment: r.comment, createdAt: r.createdAt.toISOString() })),
      },
    };
  });

  // Moderation (spec: "Platform Admin has moderation ability" over
  // ratings/feedback) — hides (never deletes) an abusive/incorrect
  // rating; unhiding is the same call with hidden:false. Hidden ratings
  // are excluded from the average/recent list above but never erased —
  // same "correction, not erasure" rule as everywhere else financial/
  // reputational history is handled in this app.
  app.patch<{ Params: { id: string } }>("/api/platform/ratings/:id", { preHandler: owner }, async (req) => {
    const body = z.object({ hidden: z.boolean() }).parse(req.body);
    const rating = await ctx.prisma.rating.update({ where: { id: req.params.id }, data: { hidden: body.hidden, hiddenAt: body.hidden ? new Date() : null } });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, body.hidden ? "platform.rating.hide" : "platform.rating.unhide", "rating", rating.id);
    return { ok: true, hidden: rating.hidden };
  });

  // Spec: "Platform Admin controls whether a rider is: freelancer/
  // platform-approved... attached only to one merchant; attached to one
  // logistics/bearer company." `attachment` and its matching id go
  // together — see the RiderAttachment doc comment in schema.prisma for
  // the eligibility rule this drives. Switching to `merchant`/`logistics`
  // requires the matching id (and clears the other); switching to
  // `freelance` clears both, regardless of what was passed.
  app.patch<{ Params: { id: string } }>("/api/platform/riders/:id", { preHandler: owner }, async (req) => {
    const body = z
      .object({
        platformStatus: z.enum(["pending", "approved", "suspended"]).optional(),
        active: z.boolean().optional(),
        attachment: z.enum(["freelance", "merchant", "logistics"]).optional(),
        attachedMerchantId: z.string().optional().nullable(),
        attachedLogisticsCompanyId: z.string().optional().nullable(),
      })
      .parse(req.body);
    if (Object.values(body).every((v) => v === undefined)) throw httpErrors.createError(400, "Nothing to update");

    let attachmentData: { attachment?: "freelance" | "merchant" | "logistics"; attachedMerchantId?: string | null; attachedLogisticsCompanyId?: string | null } = {};
    if (body.attachment !== undefined) {
      if (body.attachment === "merchant") {
        if (!body.attachedMerchantId) throw httpErrors.createError(400, "attachedMerchantId is required for attachment \"merchant\"");
        const merchant = await ctx.prisma.merchant.findUnique({ where: { id: body.attachedMerchantId } });
        if (!merchant) throw httpErrors.createError(404, "Merchant not found");
        attachmentData = { attachment: "merchant", attachedMerchantId: merchant.id, attachedLogisticsCompanyId: null };
      } else if (body.attachment === "logistics") {
        if (!body.attachedLogisticsCompanyId) throw httpErrors.createError(400, "attachedLogisticsCompanyId is required for attachment \"logistics\"");
        const company = await ctx.prisma.logisticsCompany.findUnique({ where: { id: body.attachedLogisticsCompanyId } });
        if (!company) throw httpErrors.createError(404, "Logistics company not found");
        attachmentData = { attachment: "logistics", attachedMerchantId: null, attachedLogisticsCompanyId: company.id };
      } else {
        attachmentData = { attachment: "freelance", attachedMerchantId: null, attachedLogisticsCompanyId: null };
      }
    }

    const rider = await ctx.prisma.rider.update({
      where: { id: req.params.id },
      data: { platformStatus: body.platformStatus, active: body.active, ...attachmentData },
    });
    await ctx.audit.record(
      { id: req.user!.sub, role: "platform_owner" },
      "platform.rider.update",
      "rider",
      rider.id,
      { platformStatus: body.platformStatus, active: body.active, ...attachmentData },
    );
    return { ok: true, platformStatus: rider.platformStatus, active: rider.active, attachment: rider.attachment, attachedMerchantId: rider.attachedMerchantId, attachedLogisticsCompanyId: rider.attachedLogisticsCompanyId };
  });

  // Spec: one rider can belong to more than one merchant (a many-to-many
  // MerchantRider relationship). These two routes are the platform-owner's
  // cross-merchant assignment controls: attach a rider to a merchant, or
  // detach them — removing the RELATIONSHIP only, never the rider's
  // platform account, never another merchant's relationship with that rider.
  app.post<{ Params: { id: string } }>("/api/platform/riders/:id/merchants", { preHandler: owner }, async (req) => {
    const body = z.object({ merchantId: z.string().min(1) }).parse(req.body);
    const rider = await ctx.prisma.rider.findUnique({ where: { id: req.params.id } });
    if (!rider) throw httpErrors.createError(404, "Courier not found");
    const merchant = await ctx.prisma.merchant.findUnique({ where: { id: body.merchantId } });
    if (!merchant) throw httpErrors.createError(404, "Merchant not found");
    const existing = await ctx.prisma.merchantRider.findUnique({ where: { merchantId_riderId: { merchantId: merchant.id, riderId: rider.id } } });
    if (existing?.status === "active") throw httpErrors.createError(409, "This courier is already attached to that merchant.");
    await ctx.prisma.merchantRider.upsert({
      where: { merchantId_riderId: { merchantId: merchant.id, riderId: rider.id } },
      create: { merchantId: merchant.id, riderId: rider.id, status: "active", createdById: req.user!.sub, approvedAt: new Date() },
      update: { status: "active", createdById: req.user!.sub, approvedAt: new Date() },
    });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, "platform.rider.assign_merchant", "rider", rider.id, { merchantId: merchant.id, merchantName: merchant.name });
    return { ok: true, merchantId: merchant.id, merchantName: merchant.name, riderId: rider.id };
  });

  app.delete<{ Params: { id: string; merchantId: string } }>("/api/platform/riders/:id/merchants/:merchantId", { preHandler: owner }, async (req) => {
    const rider = await ctx.prisma.rider.findUnique({ where: { id: req.params.id } });
    if (!rider) throw httpErrors.createError(404, "Courier not found");
    const rel = await ctx.prisma.merchantRider.findUnique({ where: { merchantId_riderId: { merchantId: req.params.merchantId, riderId: rider.id } } });
    if (!rel || rel.status !== "active") throw httpErrors.createError(404, "This courier is not attached to that merchant.");
    await ctx.prisma.merchantRider.update({ where: { id: rel.id }, data: { status: "removed", approvedAt: null } });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, "platform.rider.remove_merchant", "rider", rider.id, { merchantId: req.params.merchantId });
    return { ok: true, riderId: rider.id, merchantId: req.params.merchantId };
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
        deletedAt: u.deletedAt?.toISOString() ?? null,
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
    const existing = await ctx.prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) throw httpErrors.createError(404, "User not found");
    if (existing.deletedAt) throw httpErrors.createError(409, "This account has been deleted — it can no longer be disabled or reactivated.");
    const user = await ctx.prisma.user.update({ where: { id: req.params.id }, data: { active: body.active } });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, body.active ? "platform.user.reactivate" : "platform.user.disable", "user", user.id);
    return { ok: true, active: user.active };
  });

  // Master admin global delete (spec: "MASTER ADMIN MUST BE ABLE TO DELETE
  // ANY ACCOUNT FROM THE PLATFORM... customer, merchant, merchant staff,
  // courier, logistics company, logistics manager, dispatcher, any other
  // account type" — every one of those is a User row, whether their
  // access comes through a StaffMembership, MerchantStaff,
  // LogisticsCompanyStaff, or a Rider profile, so one route covers all of
  // them). Soft: deletedAt + active:false, distinct from a plain disable
  // (own audit action, own login-time message) — every historical
  // relation this user is referenced from (jobs, ratings, audit log,
  // settlements, memberships...) is completely untouched. A deleted user
  // can never log in again through any of this app's login "faces" — see
  // the deletedAt checks in auth.ts, merchant-portal.ts, and
  // logistics-portal.ts's own login routes.
  app.delete<{ Params: { id: string } }>("/api/platform/users/:id", { preHandler: owner }, async (req) => {
    if (req.params.id === req.user!.sub) {
      throw httpErrors.createError(400, "You can't delete your own account.");
    }
    const existing = await ctx.prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) throw httpErrors.createError(404, "User not found");
    if (existing.deletedAt) throw httpErrors.createError(409, "This account has already been deleted.");
    const user = await ctx.prisma.user.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), active: false } });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, "platform.user.delete", "user", user.id, { name: existing.name, email: existing.email, phone: existing.phone });
    return { ok: true, deletedAt: user.deletedAt };
  });

  // Admin impersonation (spec: "Login As" / "Enter Account", without
  // knowing or changing the target's password). Resolves the target's
  // OWN staff context exactly as a normal login would — the issued token
  // authorizes exactly what the target account itself could do, nothing
  // more; every route's own scoping/ownership checks apply completely
  // unchanged. impersonatedBy (jwt.ts) is purely an audit/UI marker, not
  // a capability grant. Deliberately access-only, no refresh token/
  // session row: it can only ever last the short access-token TTL, and
  // if it expires mid-use, the frontend's normal 401-retry falls back to
  // the ADMIN's own still-valid refresh cookie — silently ENDING the
  // impersonation rather than extending it, which is the safe direction
  // for that fallback to fail in.
  app.post<{ Params: { id: string } }>("/api/platform/users/:id/impersonate", { preHandler: owner }, async (req) => {
    if (req.params.id === req.user!.sub) {
      throw httpErrors.createError(400, "You're already signed in as yourself.");
    }
    const target = await ctx.prisma.user.findUnique({ where: { id: req.params.id }, include: { rider: { select: { id: true } } } });
    if (!target) throw httpErrors.createError(404, "User not found");
    if (target.deletedAt) throw httpErrors.createError(409, "This account has been deleted.");
    if (!target.active) throw httpErrors.createError(409, "This account is disabled — reactivate it first.");
    const staffContext = await resolveStaffContext(ctx, target);
    const accessToken = await ctx.jwt.issueAccess({
      id: target.id,
      name: target.name,
      role: staffContext?.role ?? target.role,
      riderId: target.rider?.id,
      businessId: staffContext?.businessId ?? undefined,
      platformRole: staffContext?.platformRole ?? undefined,
      impersonatedBy: req.user!.sub,
    });
    await ctx.audit.record({ id: req.user!.sub, role: "platform_owner" }, "platform.impersonation.start", "user", target.id, { targetName: target.name, targetEmail: target.email });
    return { accessToken, user: toUserDto(target) };
  });

  // Purely an audit-trail completion — the frontend just discards its
  // local copy of the impersonation token to actually "exit"; this call
  // is what makes "impersonation started / impersonation ended" (spec)
  // both real, paired audit events instead of only ever recording the
  // start. Requires an actual impersonation token (impersonatedBy set),
  // not a ordinary owner session — there's nothing to "end" otherwise.
  app.post("/api/platform/impersonation/end", { preHandler: ctx.requireAuth }, async (req) => {
    const adminId = req.user!.impersonatedBy;
    if (!adminId) throw httpErrors.createError(400, "Not currently impersonating anyone.");
    await ctx.audit.record({ id: adminId, role: "platform_owner" }, "platform.impersonation.end", "user", req.user!.sub, { targetName: req.user!.name });
    return { ok: true };
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

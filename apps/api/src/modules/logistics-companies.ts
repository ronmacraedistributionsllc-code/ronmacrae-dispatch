import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import type { LogisticsCompanyDto } from "@ronmacrae/contracts";
import { hashPassword } from "../lib/password.js";
import { sendEmailCode, consumeEmailCode } from "./customer-account.js";
import { DEFAULT_PUBLIC_BUSINESS_SLUG } from "./order.js";
import { normalizeEmail } from "../lib/email.js";
import { notifyOwnersOfApplication } from "./platform-notify.js";

/**
 * Fleet-supplier clients of the courier business (spec: "Bearer/Logistics
 * companies") — the other side of the marketplace from Merchant (see
 * schema.prisma's own doc comment on the LogisticsCompany model).
 * Deliberately mirrors merchants.ts closely: same child-of-Business shape,
 * same slug/active/portal-grant pattern. No public storefront/catalog here
 * — a logistics company supplies riders, not orders, so there's nothing
 * for a customer to browse.
 */

const CreateLogisticsCompany = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).regex(/^[a-z0-9-]+$/, "lowercase letters, numbers and hyphens only").optional(),
  phone: z.string().max(30).optional().or(z.literal("")).nullable(),
  email: z.string().email().max(160).optional().or(z.literal("")).nullable(),
  active: z.boolean().default(true),
});

const UpdateLogisticsCompany = CreateLogisticsCompany.partial();

const LogisticsStaffBody = z.object({
  email: z.string().email().max(160),
  name: z.string().max(120).optional(),
  /** Only used (and only required) when this email doesn't have an
   *  account yet — reusing an existing one never touches its password. */
  password: z.string().min(8).max(128).optional(),
});

const LogisticsSignupBody = z.object({
  ownerName: z.string().min(1).max(120),
  businessName: z.string().min(1).max(120),
  email: z.string().email().max(160),
  phone: z.string().max(30).optional().or(z.literal("")),
  password: z.string().min(8).max(128),
});

const LogisticsVerifyBody = z.object({ email: z.string().email().max(160), code: z.string().min(4).max(10) });
const LOGISTICS_EMAIL_VERIFY_PURPOSE = "verify_logistics_email";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "logistics"
  );
}

type LogisticsCompanyRow = {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: { riders: number };
};

function toDto(c: LogisticsCompanyRow): LogisticsCompanyDto {
  return {
    id: c.id,
    businessId: c.businessId,
    name: c.name,
    slug: c.slug,
    phone: c.phone,
    email: c.email,
    active: c.active,
    riderCount: c._count?.riders ?? 0,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function logisticsCompanyRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const staff = ctx.requireStaff("admin", "dispatcher");
  const owner = ctx.requireStaff("admin");

  // Public self-signup — the spec's fourth account type ("Bearer/Logistics
  // Company"), a shared-signup option that previously had none (only
  // Customer/Courier/Merchant did). Deliberately mirrors merchant-signup's
  // shape exactly: same shared User/staff-membership account system (no
  // duplicate login), same pending-until-approved application, same
  // email-verification-before-review gate, same platform-owner notification.
  app.post("/api/logistics-signup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const body = LogisticsSignupBody.parse(req.body);
    const email = normalizeEmail(body.email);
    if (!email) throw httpErrors.createError(400, "Enter a valid email address.");
    const business = await ctx.prisma.business.findUnique({ where: { slug: DEFAULT_PUBLIC_BUSINESS_SLUG } });
    if (!business) throw httpErrors.createError(503, "Logistics company sign-up is not available right now");
    const existingUser = await ctx.prisma.user.findUnique({ where: { email } });
    if (existingUser) throw httpErrors.createError(409, "This email is already associated with an account");
    const slug = slugify(body.businessName);
    const clash = await ctx.prisma.logisticsCompany.findUnique({ where: { businessId_slug: { businessId: business.id, slug } } });
    if (clash) throw httpErrors.createError(409, "A logistics company with that name already exists");
    const user = await ctx.prisma.user.create({
      data: { name: body.ownerName, email, phone: body.phone || null, passwordHash: hashPassword(body.password), role: "viewer" },
    });
    const company = await ctx.prisma.logisticsCompany.create({
      data: {
        businessId: business.id,
        name: body.businessName,
        slug,
        phone: body.phone || null,
        email,
        active: false,
        applicationStatus: "pending",
        staff: { create: { userId: user.id, active: true } },
      },
    });
    try {
      await sendEmailCode(ctx, email, LOGISTICS_EMAIL_VERIFY_PURPOSE, "Verify your logistics company account", (code) => `Your Ronmacrae logistics company verification code is ${code}. It expires in 10 minutes.`);
    } catch (err) {
      // The account/application is retained so a provider retry can complete
      // onboarding; the API truthfully reports that verification was not sent.
      ctx.log.error({ email, logisticsCompanyId: company.id, error: err instanceof Error ? err.message : String(err) }, "logistics company verification email failed");
      throw err;
    }
    await ctx.audit.record({ id: null, role: "anonymous" }, "logistics_company.signup", "logistics_company", company.id, { email });
    void notifyOwnersOfApplication(ctx, "logistics_company", { id: company.id, name: company.name, applicantEmail: email }).catch((err) =>
      ctx.log.error({ err: String(err), logisticsCompanyId: company.id }, "platform-owner application notification failed"),
    );
    return { status: "pending", logisticsCompanyId: company.id, email };
  });

  app.post("/api/logistics-signup/verify", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = LogisticsVerifyBody.parse(req.body);
    const email = normalizeEmail(body.email);
    if (!email) throw httpErrors.createError(400, "Enter a valid email address.");
    await consumeEmailCode(ctx, email, LOGISTICS_EMAIL_VERIFY_PURPOSE, body.code);
    await ctx.prisma.user.updateMany({ where: { email }, data: { emailVerifiedAt: new Date() } });
    return { ok: true, status: "pending", message: "Email verified. Your logistics company is waiting for approval." };
  });

  app.post("/api/logistics-signup/resend", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ email: z.string().email().max(160) }).parse(req.body);
    await sendEmailCode(ctx, body.email, LOGISTICS_EMAIL_VERIFY_PURPOSE, "Verify your logistics company account", (code) => `Your Ronmacrae logistics company verification code is ${code}. It expires in 10 minutes.`);
    return { ok: true };
  });

  app.get("/api/logistics-companies", { preHandler: staff }, async (req) => {
    const rows = await ctx.prisma.logisticsCompany.findMany({
      where: { businessId: req.user!.businessId! },
      include: { _count: { select: { riders: true } } },
      orderBy: { name: "asc" },
    });
    return { logisticsCompanies: rows.map(toDto) };
  });

  app.get<{ Params: { id: string } }>("/api/logistics-companies/:id", { preHandler: staff }, async (req) => {
    const c = await ctx.prisma.logisticsCompany.findFirst({
      where: { id: req.params.id, businessId: req.user!.businessId! },
      include: { _count: { select: { riders: true } } },
    });
    if (!c) throw httpErrors.createError(404, "Logistics company not found");
    return { logisticsCompany: toDto(c) };
  });

  app.post("/api/logistics-companies", { preHandler: owner }, async (req) => {
    const body = CreateLogisticsCompany.parse(req.body);
    const businessId = req.user!.businessId!;
    const slug = body.slug ? slugify(body.slug) : slugify(body.name);
    const exists = await ctx.prisma.logisticsCompany.findUnique({ where: { businessId_slug: { businessId, slug } } });
    if (exists) throw httpErrors.createError(409, `A logistics company with the slug "${slug}" already exists`);
    const company = await ctx.prisma.logisticsCompany.create({
      data: {
        businessId,
        name: body.name,
        slug,
        phone: body.phone || null,
        email: body.email || null,
        active: body.active,
      },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "logistics_company.create", "logistics_company", company.id, { name: company.name, slug: company.slug });
    return { logisticsCompany: toDto(company) };
  });

  app.patch<{ Params: { id: string } }>("/api/logistics-companies/:id", { preHandler: owner }, async (req) => {
    const body = UpdateLogisticsCompany.parse(req.body);
    const businessId = req.user!.businessId!;
    const existing = await ctx.prisma.logisticsCompany.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) throw httpErrors.createError(404, "Logistics company not found");
    let slug = existing.slug;
    if (body.slug) {
      slug = slugify(body.slug);
      if (slug !== existing.slug) {
        const clash = await ctx.prisma.logisticsCompany.findUnique({ where: { businessId_slug: { businessId, slug } } });
        if (clash) throw httpErrors.createError(409, `A logistics company with the slug "${slug}" already exists`);
      }
    }
    // Same implicit-approval sync as merchants.ts's equivalent route — see
    // its comment for the full rationale.
    const implicitlyApproved = existing.applicationStatus === "pending" && body.active === true;
    const company = await ctx.prisma.logisticsCompany.update({
      where: { id: req.params.id },
      data: {
        name: body.name,
        slug,
        phone: body.phone === undefined ? undefined : body.phone || null,
        email: body.email === undefined ? undefined : body.email || null,
        active: body.active,
        ...(implicitlyApproved ? { applicationStatus: "approved" as const, reviewedAt: new Date(), reviewedById: req.user!.sub } : {}),
      },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "logistics_company.update", "logistics_company", company.id);
    return { logisticsCompany: toDto(company) };
  });

  // Grants (or updates the password for) this company's own portal login —
  // a distinct "face" from staff, see logistics-portal.ts. Admin-only, same
  // "creating someone else's login is itself the vouching" rule as
  // merchants.ts's equivalent, including never overwriting an existing
  // account's password on a re-grant.
  app.post<{ Params: { id: string } }>("/api/logistics-companies/:id/staff", { preHandler: owner }, async (req) => {
    const body = LogisticsStaffBody.parse(req.body);
    const businessId = req.user!.businessId!;
    const company = await ctx.prisma.logisticsCompany.findFirst({ where: { id: req.params.id, businessId } });
    if (!company) throw httpErrors.createError(404, "Logistics company not found");
    const email = body.email.trim().toLowerCase();
    const existing = await ctx.prisma.user.findUnique({ where: { email } });
    if (!existing && !body.password) throw httpErrors.createError(400, "A password is required to create a new account for this email");
    const user =
      existing ??
      (await ctx.prisma.user.create({ data: { email, name: body.name || company.name, passwordHash: hashPassword(body.password!), role: "viewer" } }));
    await ctx.prisma.logisticsCompanyStaff.upsert({
      where: { userId_logisticsCompanyId: { userId: user.id, logisticsCompanyId: company.id } },
      create: { userId: user.id, logisticsCompanyId: company.id, active: true },
      update: { active: true },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "logistics_company.staff.grant", "logistics_company", company.id, { email, reusedExistingAccount: existing != null });
    return { ok: true, email, reusedExistingAccount: existing != null };
  });
}

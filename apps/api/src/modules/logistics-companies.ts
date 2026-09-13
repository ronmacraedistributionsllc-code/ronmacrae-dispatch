import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import type { LogisticsCompanyDto } from "@ronmacrae/contracts";
import { hashPassword } from "../lib/password.js";

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
    const company = await ctx.prisma.logisticsCompany.update({
      where: { id: req.params.id },
      data: {
        name: body.name,
        slug,
        phone: body.phone === undefined ? undefined : body.phone || null,
        email: body.email === undefined ? undefined : body.email || null,
        active: body.active,
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

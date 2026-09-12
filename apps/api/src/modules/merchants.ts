import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { minorOf, money } from "@ronmacrae/money";
import type { MerchantDto, MerchantPublicDto, ProductDto, ProductVariantDto } from "@ronmacrae/contracts";
import { pointFromJson, pointToJson } from "../geo-mappers.js";

/**
 * Store/merchant clients of the courier business (spec section 3: "MULTI-
 * MERCHANT / MULTI-STORE ARCHITECTURE") — e.g. "VBR Basics". Distinct from
 * `Business` (the courier/dispatch operator itself); every merchant belongs
 * to exactly one business, staff-managed within it. The public order form
 * only ever sees `MerchantPublicDto` (no phone/email/notification list).
 */

const PointSchema = z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) });

const CreateMerchant = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).regex(/^[a-z0-9-]+$/, "lowercase letters, numbers and hyphens only").optional(),
  logoUrl: z.string().url().max(500).optional().or(z.literal("")).nullable(),
  phone: z.string().max(30).optional().or(z.literal("")).nullable(),
  email: z.string().email().max(160).optional().or(z.literal("")).nullable(),
  /** Comma or newline-separated; normalized to a comma-separated string. */
  notificationEmails: z.string().max(600).optional().or(z.literal("")).nullable(),
  pickupAddressText: z.string().max(200).optional().or(z.literal("")).nullable(),
  pickupPoint: PointSchema.optional().nullable(),
  businessHours: z.string().max(300).optional().or(z.literal("")).nullable(),
  active: z.boolean().default(true),
});

const UpdateMerchant = CreateMerchant.partial();

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "merchant";
}

function parseEmails(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type MerchantRow = {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  phone: string | null;
  email: string | null;
  notificationEmails: string | null;
  pickupAddressText: string | null;
  pickupPoint: unknown;
  businessHours: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export function merchantToDto(m: MerchantRow, appOrigin: string): MerchantDto {
  return {
    id: m.id,
    businessId: m.businessId,
    name: m.name,
    slug: m.slug,
    logoUrl: m.logoUrl,
    phone: m.phone,
    email: m.email,
    notificationEmails: parseEmails(m.notificationEmails),
    pickupAddressText: m.pickupAddressText,
    pickupPoint: pointFromJson(m.pickupPoint),
    businessHours: m.businessHours,
    active: m.active,
    orderUrl: `${appOrigin}/order/${m.slug}`,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function variantToDto(v: {
  id: string;
  size: string | null;
  color: string | null;
  sku: string | null;
  priceOverride: number | null;
  inventoryQty: number | null;
  active: boolean;
}, productPrice: number, currency: string): ProductVariantDto {
  return {
    id: v.id,
    size: v.size,
    color: v.color,
    sku: v.sku,
    price: money(v.priceOverride ?? productPrice, currency),
    inventoryQty: v.inventoryQty,
    active: v.active,
  };
}

export function productToDto(p: {
  id: string;
  merchantId: string;
  name: string;
  description: string | null;
  sku: string | null;
  photoUrl: string | null;
  category: string | null;
  price: number;
  currency: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  variants: { id: string; size: string | null; color: string | null; sku: string | null; priceOverride: number | null; inventoryQty: number | null; active: boolean }[];
}): ProductDto {
  return {
    id: p.id,
    merchantId: p.merchantId,
    name: p.name,
    description: p.description,
    sku: p.sku,
    photoUrl: p.photoUrl,
    category: p.category,
    price: money(p.price, p.currency),
    active: p.active,
    variants: p.variants.map((v) => variantToDto(v, p.price, p.currency)),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function merchantRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const staff = ctx.requireStaff("admin", "dispatcher");
  const owner = ctx.requireStaff("admin");

  app.get("/api/merchants", { preHandler: staff }, async (req) => {
    const rows = await ctx.prisma.merchant.findMany({ where: { businessId: req.user!.businessId! }, orderBy: { name: "asc" } });
    return { merchants: rows.map((m) => merchantToDto(m, ctx.config.APP_ORIGIN)) };
  });

  app.get<{ Params: { id: string } }>("/api/merchants/:id", { preHandler: staff }, async (req) => {
    const m = await ctx.prisma.merchant.findFirst({ where: { id: req.params.id, businessId: req.user!.businessId! } });
    if (!m) throw httpErrors.createError(404, "Merchant not found");
    return { merchant: merchantToDto(m, ctx.config.APP_ORIGIN) };
  });

  app.post("/api/merchants", { preHandler: owner }, async (req) => {
    const body = CreateMerchant.parse(req.body);
    const businessId = req.user!.businessId!;
    const slug = body.slug ? slugify(body.slug) : slugify(body.name);
    const exists = await ctx.prisma.merchant.findUnique({ where: { businessId_slug: { businessId, slug } } });
    if (exists) throw httpErrors.createError(409, `A merchant with the link "/order/${slug}" already exists`);
    const merchant = await ctx.prisma.merchant.create({
      data: {
        businessId,
        name: body.name,
        slug,
        logoUrl: body.logoUrl || null,
        phone: body.phone || null,
        email: body.email || null,
        notificationEmails: body.notificationEmails ? parseEmails(body.notificationEmails).join(",") : null,
        pickupAddressText: body.pickupAddressText || null,
        pickupPoint: pointToJson(body.pickupPoint ?? null) ?? undefined,
        businessHours: body.businessHours || null,
        active: body.active,
      },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "merchant.create", "merchant", merchant.id, { name: merchant.name, slug: merchant.slug });
    return { merchant: merchantToDto(merchant, ctx.config.APP_ORIGIN) };
  });

  app.patch<{ Params: { id: string } }>("/api/merchants/:id", { preHandler: owner }, async (req) => {
    const body = UpdateMerchant.parse(req.body);
    const businessId = req.user!.businessId!;
    const existing = await ctx.prisma.merchant.findFirst({ where: { id: req.params.id, businessId } });
    if (!existing) throw httpErrors.createError(404, "Merchant not found");
    let slug = existing.slug;
    if (body.slug) {
      slug = slugify(body.slug);
      if (slug !== existing.slug) {
        const clash = await ctx.prisma.merchant.findUnique({ where: { businessId_slug: { businessId, slug } } });
        if (clash) throw httpErrors.createError(409, `A merchant with the link "/order/${slug}" already exists`);
      }
    }
    const merchant = await ctx.prisma.merchant.update({
      where: { id: req.params.id },
      data: {
        name: body.name,
        slug,
        logoUrl: body.logoUrl === undefined ? undefined : body.logoUrl || null,
        phone: body.phone === undefined ? undefined : body.phone || null,
        email: body.email === undefined ? undefined : body.email || null,
        notificationEmails: body.notificationEmails === undefined ? undefined : body.notificationEmails ? parseEmails(body.notificationEmails).join(",") : null,
        pickupAddressText: body.pickupAddressText === undefined ? undefined : body.pickupAddressText || null,
        pickupPoint: body.pickupPoint === undefined ? undefined : (pointToJson(body.pickupPoint ?? null) ?? undefined),
        businessHours: body.businessHours === undefined ? undefined : body.businessHours || null,
        active: body.active,
      },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "merchant.update", "merchant", merchant.id);
    return { merchant: merchantToDto(merchant, ctx.config.APP_ORIGIN) };
  });

  // ---------------------------------------------------------------------
  // Public — no auth. Only the narrow, safe subset a customer needs to
  // land on /order/:slug already knowing which merchant they're ordering
  // from. A disabled/inactive or unknown merchant is a plain 404 — the
  // public page never learns *why* a link doesn't resolve.
  // ---------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>("/api/merchants/public/:slug", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const m = await ctx.prisma.merchant.findFirst({ where: { slug: req.params.slug, active: true } });
    if (!m) throw httpErrors.createError(404, "This order link isn't available");
    const productCount = await ctx.prisma.product.count({ where: { merchantId: m.id, active: true } });
    const dto: MerchantPublicDto = {
      id: m.id,
      name: m.name,
      slug: m.slug,
      logoUrl: m.logoUrl,
      pickupAddressText: m.pickupAddressText,
      hasCatalog: productCount > 0,
      businessHours: m.businessHours,
    };
    return { merchant: dto };
  });

  app.get<{ Params: { slug: string } }>("/api/merchants/public/:slug/products", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const m = await ctx.prisma.merchant.findFirst({ where: { slug: req.params.slug, active: true } });
    if (!m) throw httpErrors.createError(404, "This order link isn't available");
    const rows = await ctx.prisma.product.findMany({
      where: { merchantId: m.id, active: true },
      include: { variants: { where: { active: true } } },
      orderBy: { name: "asc" },
    });
    return { products: rows.map(productToDto) };
  });

  // ---------------------------------------------------------------------
  // Catalog (optional — spec section 7: "if a merchant does not use a full
  // product catalog yet, allow manual/free-text item entry"). Staff-only.
  // ---------------------------------------------------------------------
  const CreateProduct = z.object({
    name: z.string().min(1).max(160),
    description: z.string().max(1000).optional().or(z.literal("")).nullable(),
    sku: z.string().max(60).optional().or(z.literal("")).nullable(),
    photoUrl: z.string().url().max(500).optional().or(z.literal("")).nullable(),
    category: z.string().max(80).optional().or(z.literal("")).nullable(),
    price: z.number().min(0).max(10_000_000),
    active: z.boolean().default(true),
    variants: z
      .array(
        z.object({
          size: z.string().max(40).optional().or(z.literal("")).nullable(),
          color: z.string().max(40).optional().or(z.literal("")).nullable(),
          sku: z.string().max(60).optional().or(z.literal("")).nullable(),
          priceOverride: z.number().min(0).max(10_000_000).optional().nullable(),
          inventoryQty: z.number().int().min(0).optional().nullable(),
        }),
      )
      .max(50)
      .default([]),
  });

  app.get<{ Params: { merchantId: string } }>("/api/merchants/:merchantId/products", { preHandler: staff }, async (req) => {
    const merchant = await ctx.prisma.merchant.findFirst({ where: { id: req.params.merchantId, businessId: req.user!.businessId! } });
    if (!merchant) throw httpErrors.createError(404, "Merchant not found");
    const rows = await ctx.prisma.product.findMany({ where: { merchantId: merchant.id }, include: { variants: true }, orderBy: { name: "asc" } });
    return { products: rows.map(productToDto) };
  });

  app.post<{ Params: { merchantId: string } }>("/api/merchants/:merchantId/products", { preHandler: staff }, async (req) => {
    const merchant = await ctx.prisma.merchant.findFirst({ where: { id: req.params.merchantId, businessId: req.user!.businessId! } });
    if (!merchant) throw httpErrors.createError(404, "Merchant not found");
    const body = CreateProduct.parse(req.body);
    const cur = ctx.config.OPERATIONAL_CURRENCY;
    const product = await ctx.prisma.product.create({
      data: {
        merchantId: merchant.id,
        name: body.name,
        description: body.description || null,
        sku: body.sku || null,
        photoUrl: body.photoUrl || null,
        category: body.category || null,
        price: minorOf(body.price, cur),
        currency: cur,
        active: body.active,
        variants: {
          create: body.variants.map((v) => ({
            size: v.size || null,
            color: v.color || null,
            sku: v.sku || null,
            priceOverride: v.priceOverride != null ? minorOf(v.priceOverride, cur) : null,
            inventoryQty: v.inventoryQty ?? null,
          })),
        },
      },
      include: { variants: true },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "product.create", "product", product.id, { merchantId: merchant.id, name: product.name });
    return { product: productToDto(product) };
  });

  app.patch<{ Params: { id: string } }>("/api/products/:id", { preHandler: staff }, async (req) => {
    const existing = await ctx.prisma.product.findFirst({ where: { id: req.params.id }, include: { merchant: true } });
    if (!existing || existing.merchant.businessId !== req.user!.businessId!) throw httpErrors.createError(404, "Product not found");
    const body = CreateProduct.partial().parse(req.body);
    const cur = ctx.config.OPERATIONAL_CURRENCY;
    const product = await ctx.prisma.product.update({
      where: { id: req.params.id },
      data: {
        name: body.name,
        description: body.description === undefined ? undefined : body.description || null,
        sku: body.sku === undefined ? undefined : body.sku || null,
        photoUrl: body.photoUrl === undefined ? undefined : body.photoUrl || null,
        category: body.category === undefined ? undefined : body.category || null,
        price: body.price != null ? minorOf(body.price, cur) : undefined,
        active: body.active,
      },
      include: { variants: true },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "product.update", "product", product.id);
    return { product: productToDto(product) };
  });

  app.delete<{ Params: { id: string } }>("/api/products/:id", { preHandler: staff }, async (req) => {
    const existing = await ctx.prisma.product.findFirst({ where: { id: req.params.id }, include: { merchant: true } });
    if (!existing || existing.merchant.businessId !== req.user!.businessId!) throw httpErrors.createError(404, "Product not found");
    // Never a hard delete once it's been ordered — an order's JobItem keeps
    // its own price/name snapshot regardless (productId goes SetNull), but
    // deactivating (not deleting) a product that's already in real orders
    // keeps the catalog itself honest without touching order history.
    const used = await ctx.prisma.jobItem.count({ where: { productId: existing.id } });
    if (used > 0) {
      const product = await ctx.prisma.product.update({ where: { id: existing.id }, data: { active: false }, include: { variants: true } });
      await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "product.deactivate", "product", product.id, { reason: `used on ${used} order(s)` });
      return { product: productToDto(product), deactivatedInstead: true };
    }
    await ctx.prisma.product.delete({ where: { id: existing.id } });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "product.delete", "product", existing.id);
    return { ok: true };
  });
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { verifyPassword } from "../lib/password.js";
import { normalizeEmail } from "../lib/email.js";
import { jobInclude, type JobRow } from "./jobs/dto.js";
import { money, minorOf } from "@ronmacrae/money";
import { moneyField } from "../geo-mappers.js";
import type { PaymentMethod } from "@ronmacrae/contracts";
import { PAYMENT_METHOD_LABELS } from "@ronmacrae/contracts";
import { CreateProduct, productToDto } from "./merchants.js";
import { resolveStaffContext, toUserDto } from "./auth.js";

/**
 * A merchant's own login (spec: "a merchant should have a login where
 * they can view [their orders] as well") — its own auth "face", same
 * pattern as riders (bearer) and customers (dashboard): a distinct JWT
 * type (jwt.ts's merchant_portal), verified per-route via
 * requireMerchantAuth below rather than a global preHandler, matching
 * customer-account.ts's own style. Scoped to exactly one merchant — never
 * a whole Business, never another merchant's orders.
 *
 * What a merchant login can see is deliberately a *narrower* shape than
 * the staff JobDto (no COD accountant notes/approvals, no rider payout
 * figures, nothing about other customers or other merchants) — see
 * MerchantOrderDto below.
 */

const LoginBody = z.object({
  email: z.string().email().max(160),
  password: z.string().min(1).max(128),
});

interface MerchantAuth {
  userId: string;
  merchantId: string;
}

async function requireMerchantAuth(ctx: AppCtx, req: FastifyRequest): Promise<MerchantAuth> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw httpErrors.createError(401, "Sign in to the merchant portal first.");
  const payload = await ctx.jwt.verifyMerchantPortal(token);
  if (!payload) throw httpErrors.createError(401, "Your session has expired — sign in again.");
  return { userId: payload.sub, merchantId: payload.merchantId };
}

interface MerchantOrderItem {
  name: string;
  quantity: number;
  size: string | null;
  color: string | null;
  unitPrice: ReturnType<typeof money>;
}

interface MerchantOrderDto {
  id: string;
  jobNumber: string | null;
  status: string;
  createdAt: string;
  scheduledAt: string | null;
  completedAt: string | null;
  customerName: string;
  customerPhone: string;
  addressText: string | null;
  items: MerchantOrderItem[];
  subtotal: ReturnType<typeof moneyField>;
  total: ReturnType<typeof moneyField>;
  paymentMethodLabel: string;
  riderName: string | null;
}

function toMerchantOrderDto(job: JobRow): MerchantOrderDto {
  const cur = job.currency;
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    customerName: job.customer.name,
    customerPhone: job.customer.phone,
    addressText: job.addressText,
    items: job.items.map((it) => ({ name: it.name, quantity: it.quantity, size: it.size, color: it.color, unitPrice: money(it.unitPrice, it.currency) })),
    subtotal: moneyField(job.subtotal, cur),
    total: moneyField(job.subtotal ?? job.amountExpected, cur),
    paymentMethodLabel: PAYMENT_METHOD_LABELS[job.paymentMethod as PaymentMethod] ?? job.paymentMethod,
    riderName: job.rider?.name ?? null,
  };
}

export async function merchantPortalRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post("/api/merchant-portal/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const body = LoginBody.parse(req.body);
    const email = normalizeEmail(body.email);
    const genericError = () => httpErrors.createError(401, "Incorrect email or password.");
    if (!email) throw genericError();
    const user = await ctx.prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(body.password, user.passwordHash)) throw genericError();
    const membership = await ctx.prisma.merchantStaff.findFirst({
      where: { userId: user.id, active: true },
      include: { merchant: { select: { id: true, name: true, active: true } } },
    });
    if (!membership || !membership.merchant.active) throw httpErrors.createError(403, "This account has no active merchant access.");
    const token = await ctx.jwt.issueMerchantPortal(user.id, membership.merchantId);
    await ctx.audit.record({ id: user.id, role: "merchant" }, "merchant_portal.login", "merchant", membership.merchantId);
    return { token, merchant: { id: membership.merchant.id, name: membership.merchant.name }, user: { name: user.name, email: user.email } };
  });

  app.get("/api/merchant-portal/me", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const merchant = await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: auth.merchantId } });
    // hasStaffAccess lets the portal offer "Switch workspace" without
    // guessing — the actual switch (an access token, no re-login) is
    // POST /api/merchant-portal/switch-to-staff below.
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, role: true, platformRole: true } });
    const staffContext = await resolveStaffContext(ctx, user);
    return { merchant: { id: merchant.id, name: merchant.name, active: merchant.active }, hasStaffAccess: staffContext !== null };
  });

  // The reverse of /api/auth/switch-to-merchant — an already-authenticated
  // merchant session jumping to its staff/rider access, if any, without a
  // second password entry. Deliberately access-token-only (no refresh
  // cookie): this switched-in staff session lasts ~15 minutes, then needs
  // a real re-login — a documented, acceptable limit rather than
  // replicating the full session/cookie machinery from a merchant-token
  // context.
  app.post("/api/merchant-portal/switch-to-staff", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { rider: { select: { id: true } } } });
    const staffContext = await resolveStaffContext(ctx, user);
    if (!staffContext) throw httpErrors.createError(403, "This account has no staff or rider access to switch to.");
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

  app.get("/api/merchant-portal/orders", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const jobs = await ctx.prisma.job.findMany({
      where: { merchantId: auth.merchantId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: jobInclude,
    });
    return { orders: jobs.map(toMerchantOrderDto) };
  });

  // -----------------------------------------------------------------
  // Catalog — same validation/shape as the staff-side equivalent in
  // merchants.ts (CreateProduct, productToDto), reused rather than
  // duplicated; the only real difference is authorization (a merchant
  // can only ever touch its own merchantId, taken from its own token,
  // never a client-supplied one).
  // -----------------------------------------------------------------
  app.get("/api/merchant-portal/products", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const rows = await ctx.prisma.product.findMany({ where: { merchantId: auth.merchantId }, include: { variants: true }, orderBy: { name: "asc" } });
    return { products: rows.map(productToDto) };
  });

  app.post("/api/merchant-portal/products", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const body = CreateProduct.parse(req.body);
    const cur = ctx.config.OPERATIONAL_CURRENCY;
    const product = await ctx.prisma.product.create({
      data: {
        merchantId: auth.merchantId,
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
    await ctx.audit.record({ id: auth.userId, role: "merchant" }, "product.create", "product", product.id, { merchantId: auth.merchantId, name: product.name });
    return { product: productToDto(product) };
  });

  app.patch<{ Params: { id: string } }>("/api/merchant-portal/products/:id", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const existing = await ctx.prisma.product.findFirst({ where: { id: req.params.id, merchantId: auth.merchantId } });
    if (!existing) throw httpErrors.createError(404, "Product not found");
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
    await ctx.audit.record({ id: auth.userId, role: "merchant" }, "product.update", "product", product.id);
    return { product: productToDto(product) };
  });

  app.delete<{ Params: { id: string } }>("/api/merchant-portal/products/:id", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const existing = await ctx.prisma.product.findFirst({ where: { id: req.params.id, merchantId: auth.merchantId } });
    if (!existing) throw httpErrors.createError(404, "Product not found");
    // Same "deactivate, never hard-delete once ordered" rule as the
    // staff-side endpoint — an order's JobItem keeps its own snapshot
    // regardless, but the catalog itself should stay honest.
    const used = await ctx.prisma.jobItem.count({ where: { productId: existing.id } });
    if (used > 0) {
      const product = await ctx.prisma.product.update({ where: { id: existing.id }, data: { active: false }, include: { variants: true } });
      await ctx.audit.record({ id: auth.userId, role: "merchant" }, "product.deactivate", "product", product.id, { reason: `used on ${used} order(s)` });
      return { product: productToDto(product), deactivatedInstead: true };
    }
    await ctx.prisma.product.delete({ where: { id: existing.id } });
    await ctx.audit.record({ id: auth.userId, role: "merchant" }, "product.delete", "product", existing.id);
    return { ok: true };
  });
}

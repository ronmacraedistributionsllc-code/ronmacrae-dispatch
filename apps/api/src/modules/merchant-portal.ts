import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { verifyPassword } from "../lib/password.js";
import { normalizeEmail } from "../lib/email.js";
import { jobInclude, type JobRow } from "./jobs/dto.js";
import { money } from "@ronmacrae/money";
import { moneyField } from "../geo-mappers.js";
import type { PaymentMethod } from "@ronmacrae/contracts";
import { PAYMENT_METHOD_LABELS } from "@ronmacrae/contracts";

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
    return { merchant: { id: merchant.id, name: merchant.name, active: merchant.active } };
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
}

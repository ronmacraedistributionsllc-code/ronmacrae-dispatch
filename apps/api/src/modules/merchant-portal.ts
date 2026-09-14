import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import { Prisma } from "@prisma/client";
import type { AppCtx } from "../ctx.js";
import { verifyPassword } from "../lib/password.js";
import { normalizeEmail } from "../lib/email.js";
import { jobInclude, type JobRow } from "./jobs/dto.js";
import { money, minorOf } from "@ronmacrae/money";
import { moneyField, pointToJson } from "../geo-mappers.js";
import type { GeoPoint, PaymentMethod } from "@ronmacrae/contracts";
import { ACTIVE_JOB_STATUSES, PAYMENT_METHOD_LABELS, roomForDispatch, roomForJob, roomForRider } from "@ronmacrae/contracts";
import { CreateProduct, productToDto } from "./merchants.js";
import { normalizePhone, resolveStaffContext, toUserDto } from "./auth.js";
import { listOwnerUserThread, sendOwnerUserMessage, SendPlatformMessageBody } from "./platform-messages.js";
import { deliveryPin } from "../lib/ids.js";
import { CustomersService } from "./customers.js";
import { ZonesService } from "./zones.js";
import { FareEngine } from "./quotes.js";
import { isUniqueViolation, nextJobNumber } from "./jobs/repository.js";
import { createTrackingLink } from "./jobs/history.js";
import { sendDispatchOrderNotification } from "./dispatch-notify.js";

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

/** A courier in this merchant's roster (spec: "a merchant should have a
 *  login where they can view [their orders] as well" — and, here, manage
 *  the couriers attached to their store). This is the MerchantRider
 *  relationship's merchant-facing shape: just what a merchant legitimately
 *  needs about their own couriers, never another merchant's data. */
interface MerchantRiderDto {
  id: string;
  name: string;
  phone: string;
  vehicle: string;
  plate: string | null;
  /** Live availability (offline/available/on_job/unavailable). */
  status: string;
  /** Whether the rider's own account is enabled (rider.active). */
  active: boolean;
  /** Platform-wide approval gate (pending/approved/suspended). */
  platformStatus: string;
  /** When this merchant attached this courier (relationship createdAt). */
  addedAt: string;
}

/** Which identifier to look an existing courier up by. Prefer a strong
 *  identifier (riderId or phone) over name; email resolves via the rider's
 *  linked login. */
const AddRiderBody = z.object({
  riderId: z.string().min(1).max(64).optional(),
  phone: z.string().min(7).max(20).optional(),
  email: z.string().email().max(160).optional(),
});

const PointSchema = z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) });

/** One line of a merchant-booked order. A catalog pick (`productId`) reuses
 *  the server's own price; a free-text item (`name`) carries its own price
 *  and may optionally be saved back into the merchant's catalog
 *  (`saveToCatalog`) so it can be selected again on a later booking. */
const MerchantOrderItem = z
  .object({
    productId: z.string().min(1).optional().nullable(),
    name: z.string().max(160).optional(),
    quantity: z.number().int().min(1).max(999).default(1),
    unitPrice: z.number().min(0).max(10_000_000).optional().nullable(),
    notes: z.string().max(300).optional().nullable(),
    saveToCatalog: z.boolean().default(false),
  })
  .refine((v) => v.productId || (v.name && v.name.trim().length > 0), { message: "Each item needs either a catalog pick or a name" });

const MerchantOrderBody = z.object({
  customerName: z.string().min(1).max(120),
  customerPhone: z.string().min(7).max(20),
  customerEmail: z.string().email().max(160).optional().or(z.literal("")).nullable(),
  addressText: z.string().min(3).max(200),
  point: PointSchema.optional().nullable(),
  items: z.array(MerchantOrderItem).min(1).max(40),
  paymentMethod: z.enum(["cod", "online", "card", "transfer", "paid_at_store", "other"]).default("cod"),
  instructions: z.string().max(500).optional().or(z.literal("")).nullable(),
  scheduledAt: z.coerce.date().optional().nullable(),
});

const AssignRiderBody = z.object({ riderId: z.string().min(1) });

/** Case-insensitive catalog lookup so "save to catalog" never creates a
 *  duplicate of an item the merchant already has. Exact match first, then a
 *  tolerant scan of name-contains matches compared in lower case. */
async function findProductByName(ctx: AppCtx, merchantId: string, name: string) {
  const exact = await ctx.prisma.product.findFirst({ where: { merchantId, name } });
  if (exact) return exact;
  const lower = name.toLowerCase();
  const candidates = await ctx.prisma.product.findMany({ where: { merchantId, name: { contains: name } }, take: 20 });
  return candidates.find((p) => p.name.toLowerCase() === lower) ?? null;
}

export async function merchantPortalRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post("/api/merchant-portal/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const body = LoginBody.parse(req.body);
    const email = normalizeEmail(body.email);
    const genericError = () => httpErrors.createError(401, "Incorrect email or password.");
    if (!email) throw genericError();
    const user = await ctx.prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(body.password, user.passwordHash)) throw genericError();
    if (!user.emailVerifiedAt) throw httpErrors.createError(403, "Please verify your email before signing in.");
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
    // Merchant's own average rating (spec: merchant rating display) —
    // computed from real customer ratings, never hardcoded.
    const ratingAgg = await ctx.prisma.rating.aggregate({ where: { merchantId: merchant.id, hidden: false }, _avg: { score: true }, _count: true });
    return {
      merchant: { id: merchant.id, name: merchant.name, active: merchant.active },
      rating: { average: ratingAgg._avg.score ?? null, count: ratingAgg._count },
      hasStaffAccess: staffContext !== null,
    };
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

  // "Message the owner" (spec: "admin-to-anyone") — see platform-messages.ts
  // for the shared thread logic; this merchant's own userId is the thread.
  app.get("/api/merchant-portal/messages/owner", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    return listOwnerUserThread(ctx, auth.userId, "user", auth.userId, true);
  });

  app.post("/api/merchant-portal/messages/owner", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const body = SendPlatformMessageBody.parse(req.body);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    await sendOwnerUserMessage(ctx, auth.userId, "user", auth.userId, user.name, body.body);
    return listOwnerUserThread(ctx, auth.userId, "user", auth.userId, true);
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
  // Book a delivery (spec: merchant must be able to create a real delivery
  // request from their own login). Scoped to this merchant: pickup is the
  // merchant's own saved address, the customer is created/upserted on the
  // merchant's business, and the job carries this merchant's id. Free-text
  // items can optionally be saved back to this merchant's catalog.
  // -----------------------------------------------------------------
  app.post("/api/merchant-portal/orders", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const body = MerchantOrderBody.parse(req.body);
    const merchant = await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: auth.merchantId } });
    const cur = ctx.config.OPERATIONAL_CURRENCY;

    // Resolve each item to a server-trusted price, and (optionally) persist
    // free-text items into this merchant's catalog — deduped by name.
    type Resolved = { productId: string | null; name: string; quantity: number; unitPriceMinor: number; notes: string | null };
    const items: Resolved[] = [];
    for (const item of body.items) {
      if (item.productId) {
        const product = await ctx.prisma.product.findFirst({ where: { id: item.productId, merchantId: merchant.id } });
        if (!product) throw httpErrors.createError(404, "One of the items in this order is no longer available");
        items.push({ productId: product.id, name: product.name, quantity: item.quantity, unitPriceMinor: product.price, notes: item.notes || null });
      } else {
        const name = item.name!.trim();
        const unitPriceMinor = item.unitPrice != null ? minorOf(item.unitPrice, cur) : 0;
        items.push({ productId: null, name, quantity: item.quantity, unitPriceMinor, notes: item.notes || null });
        if (item.saveToCatalog) {
          const existing = await findProductByName(ctx, merchant.id, name);
          if (!existing) {
            const created = await ctx.prisma.product.create({
              data: { merchantId: merchant.id, name, price: unitPriceMinor, currency: cur, active: true },
            });
            await ctx.audit.record({ id: auth.userId, role: "merchant" }, "product.create", "product", created.id, { merchantId: merchant.id, name, fromOrder: true });
          }
        }
      }
    }

    const customer = await new CustomersService(ctx).upsertFromRequest(merchant.businessId, {
      name: body.customerName,
      phone: body.customerPhone,
      email: body.customerEmail || null,
      addressText: body.addressText,
      point: body.point ?? null,
      consentTracking: true,
    });

    const subtotalMinor = items.reduce((s, it) => s + it.unitPriceMinor * it.quantity, 0);
    const pickupPoint = merchant.pickupPoint ? (merchant.pickupPoint as unknown as GeoPoint) : null;
    const destination = body.point ?? null;

    let feeMinor: number | null = null;
    let zoneId: string | null = null;
    if (destination) {
      const zones = new ZonesService(ctx);
      const zone = await zones.detect(merchant.businessId, destination);
      zoneId = zone.zoneId;
      if (pickupPoint) {
        try {
          const quote = await new FareEngine(ctx, zones).quote(merchant.businessId, { fromPoint: pickupPoint, toPoint: destination });
          feeMinor = quote.fee.amount;
        } catch {
          feeMinor = null;
        }
      }
    }
    const totalMinor = subtotalMinor + (feeMinor ?? 0);
    const cod = body.paymentMethod === "cod";
    const summary = items.map((it) => (it.quantity > 1 ? `${it.quantity}× ${it.name}` : it.name)).join(", ").slice(0, 200);

    let row: JobRow | null = null;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      try {
        row = await ctx.prisma.$transaction(async (tx) => {
          const job = await tx.job.create({
            data: {
              businessId: merchant.businessId,
              merchantId: merchant.id,
              jobNumber: await nextJobNumber(ctx, merchant.businessId),
              source: "merchant_portal",
              customerId: customer.id,
              type: "delivery",
              status: "new",
              priority: "normal",
              addressText: body.addressText,
              point: pointToJson(destination) ?? Prisma.JsonNull,
              pickupPoint: pointToJson(pickupPoint) ?? Prisma.JsonNull,
              pickupAddressText: merchant.pickupAddressText,
              pickupContact: merchant.phone,
              itemSummary: summary,
              quantity: items.reduce((s, it) => s + it.quantity, 0),
              instructions: body.instructions || null,
              zoneId,
              fare: subtotalMinor,
              fee: feeMinor,
              subtotal: totalMinor,
              currency: cur,
              paymentMethod: body.paymentMethod,
              paymentStatus: cod ? "unpaid" : "paid",
              pin: deliveryPin(ctx.config.PIN_LENGTH),
              amountExpected: totalMinor,
              amountCollected: 0,
              scheduledAt: body.scheduledAt ?? null,
              items: {
                create: items.map((it) => ({
                  productId: it.productId,
                  name: it.name,
                  quantity: it.quantity,
                  unitPrice: it.unitPriceMinor,
                  currency: cur,
                  notes: it.notes,
                })),
              },
            },
            include: jobInclude,
          });
          await tx.jobEvent.create({
            data: {
              jobId: job.id,
              from: null,
              to: "new",
              actorType: "merchant",
              actorId: auth.userId,
              actorName: merchant.name,
              note: null,
              meta: { source: "merchant_portal", itemCount: items.length } as object,
            },
          });
          return job;
        });
      } catch (err) {
        if (!isUniqueViolation(err) || attempt === 4) throw err;
      }
    }
    if (!row) throw httpErrors.createError(409, "Could not allocate a job number");

    const link = await createTrackingLink(ctx, row.id, { role: "merchant", businessId: merchant.businessId });
    await ctx.audit.record({ id: auth.userId, role: "merchant" }, "order.create", "job", row.id, { merchantId: merchant.id, itemCount: items.length });
    void sendDispatchOrderNotification(ctx, row.id).catch((err) => ctx.log.error({ err: String(err), jobId: row.id }, "dispatch order email failed"));

    return { order: toMerchantOrderDto(row), jobId: row.id, tracking: link };
  });

  // -----------------------------------------------------------------
  // Assign one of this merchant's own couriers to one of its own orders.
  // Authorization is merchant-scoped server-side: the job must belong to
  // this merchant AND the courier must be in this merchant's active
  // MerchantRider roster (plus still an active member of the business).
  // -----------------------------------------------------------------
  app.post<{ Params: { jobId: string } }>("/api/merchant-portal/orders/:jobId/assign", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const { riderId } = AssignRiderBody.parse(req.body);
    const job = await ctx.prisma.job.findFirst({ where: { id: req.params.jobId, merchantId: auth.merchantId, deletedAt: null } });
    if (!job) throw httpErrors.createError(404, "Order not found");
    const merchantName = (await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: auth.merchantId }, select: { name: true } })).name;
    if (job.status !== "new" && job.status !== "assigned") throw httpErrors.createError(409, `Only new or unaccepted orders can be assigned (order is ${job.status})`);

    const rider = await ctx.prisma.rider.findUnique({ where: { id: riderId } });
    if (!rider) throw httpErrors.createError(404, "Courier not found");
    if (!rider.active) throw httpErrors.createError(409, `${rider.name} is not active`);
    const roster = await ctx.prisma.merchantRider.findUnique({ where: { merchantId_riderId: { merchantId: auth.merchantId, riderId: riderId } } });
    if (!roster || roster.status !== "active") throw httpErrors.createError(404, "Courier not found in your roster — attach them first.");
    const membership = await ctx.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId, businessId: job.businessId } } });
    if (membership?.status !== "active") throw httpErrors.createError(404, "Courier not found");

    const oldRiderId = job.riderId;
    const reassign = job.status === "assigned" && oldRiderId != null && oldRiderId !== riderId;
    const activeCount = await ctx.prisma.job.count({ where: { riderId, status: { in: [...ACTIVE_JOB_STATUSES] } } });
    const takesNewSlot = oldRiderId !== riderId && ACTIVE_JOB_STATUSES.includes(job.status as (typeof ACTIVE_JOB_STATUSES)[number]);
    if (activeCount + (takesNewSlot ? 1 : 0) > rider.dailyCapacity) throw httpErrors.createError(409, `${rider.name} is at capacity`);

    const from = job.status;
    const to = job.status === "new" ? "assigned" : job.status;
    const claimed = await ctx.prisma.job.updateMany({ where: { id: job.id, status: from, riderId: oldRiderId }, data: { riderId, status: to, stage: "heading_to_pickup" } });
    if (!claimed.count) throw httpErrors.createError(409, "Order state changed — please refresh and try again");

    await ctx.prisma.$transaction([
      ctx.prisma.jobOffer.updateMany({ where: { jobId: job.id, status: "open" }, data: { status: "withdrawn", note: "assigned" } }),
      ...(reassign && oldRiderId ? [ctx.prisma.riderAssignment.updateMany({ where: { jobId: job.id, riderId: oldRiderId, status: { in: ["assigned", "accepted"] } }, data: { status: "reassigned" } })] : []),
      ctx.prisma.riderAssignment.create({ data: { jobId: job.id, riderId, status: "assigned", oldRiderId: reassign ? oldRiderId : null } }),
      ctx.prisma.jobEvent.create({ data: { jobId: job.id, from, to, actorType: "merchant", actorId: auth.userId, actorName: merchantName, note: reassign ? "reassigned" : null, meta: { riderId, oldRiderId: reassign ? oldRiderId : null } as object } }),
    ]);

    const updated = await ctx.prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: jobInclude });
    ctx.hub.broadcastMany([roomForRider(riderId), roomForDispatch(job.businessId)], { type: "job.assigned", payload: { job: { id: updated.id }, riderId, source: "merchant" } });
    ctx.hub.broadcastMany([roomForJob(job.id), roomForDispatch(job.businessId)], { type: "job.state", payload: { job: { id: updated.id, status: updated.status, riderId } } });
    await ctx.audit.record({ id: auth.userId, role: "merchant" }, "merchant.order.assign", "job", job.id, { riderId });
    return { order: toMerchantOrderDto(updated) };
  });

  // Merchant rates the rider (spec: "Authorized customer and merchant may
  // rate after a completed delivery") — same one-per-side rule as the
  // customer's own rating endpoint (tracking.ts), enforced by the same
  // schema unique constraint. Scoped to this merchant's own order only —
  // a merchant can never rate a job that isn't theirs.
  app.post<{ Params: { jobId: string } }>("/api/merchant-portal/orders/:jobId/rate", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const body = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(500).optional().or(z.literal("")).nullable() }).parse(req.body);
    const job = await ctx.prisma.job.findFirst({ where: { id: req.params.jobId, merchantId: auth.merchantId, deletedAt: null } });
    if (!job) throw httpErrors.createError(404, "Order not found");
    if (job.status !== "delivered" || !job.riderId) throw httpErrors.createError(400, "This order hasn't been delivered yet — nothing to rate.");
    const existing = await ctx.prisma.rating.findUnique({ where: { jobId_raterType: { jobId: job.id, raterType: "merchant" } } });
    if (existing) throw httpErrors.createError(409, "This order has already been rated.");
    const rating = await ctx.prisma.rating.create({
      data: { jobId: job.id, riderId: job.riderId, merchantId: null, raterType: "merchant", score: body.score, comment: body.comment || null },
    });
    return { ok: true, rating: { id: rating.id, score: rating.score } };
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

  // -----------------------------------------------------------------
  // Couriers — a merchant's own rider roster (spec: merchant rider
  // management). Backed by the many-to-many MerchantRider relationship:
  // one merchant can have many couriers, one courier can belong to many
  // merchants, and removing a courier here only removes THIS relationship.
  // Every query is scoped to auth.merchantId server-side — a merchant can
  // never see or touch another merchant's roster.
  // -----------------------------------------------------------------
  const merchantRiderDto = (rider: { id: string; name: string; phone: string; vehicle: string; plate: string | null; status: string; active: boolean; platformStatus: string }, addedAt: Date): MerchantRiderDto => ({
    id: rider.id,
    name: rider.name,
    phone: rider.phone,
    vehicle: rider.vehicle,
    plate: rider.plate,
    status: rider.status,
    active: rider.active,
    platformStatus: rider.platformStatus,
    addedAt: addedAt.toISOString(),
  });

  const resolveRiderReference = async (body: z.infer<typeof AddRiderBody>) => {
    if (body.riderId) return ctx.prisma.rider.findUnique({ where: { id: body.riderId } });
    if (body.phone) return ctx.prisma.rider.findUnique({ where: { phone: normalizePhone(body.phone) } });
    if (body.email) {
      const email = normalizeEmail(body.email);
      if (email) return ctx.prisma.rider.findFirst({ where: { user: { email } } });
    }
    throw httpErrors.createError(400, "Provide a courier ID, phone, or email to add.");
  };

  app.get("/api/merchant-portal/riders", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const rows = await ctx.prisma.merchantRider.findMany({
      where: { merchantId: auth.merchantId, status: "active" },
      include: { rider: true },
      orderBy: { createdAt: "desc" },
    });
    return { riders: rows.map((rel) => merchantRiderDto(rel.rider, rel.createdAt)) };
  });

  // Stage D (spec: "a courier can attach to multiple merchants only after
  // Platform Admin approval or authorized business assignment" — a
  // merchant vouching for a courier who is already an active, approved
  // member of that merchant's own business is exactly the "authorized
  // business assignment" case, same "the vouching party is themselves
  // already vetted" pattern used everywhere else in this app). Search (and
  // add, below) are therefore scoped to couriers who are active
  // RiderMembership members of THIS merchant's own business — never the
  // whole platform. Before this fix, search returned every rider on the
  // entire platform regardless of business, which let any merchant
  // discover riders it has no relationship with at all.
  app.get("/api/merchant-portal/riders/search", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const merchant = await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: auth.merchantId }, select: { businessId: true } });
    const { q } = z.object({ q: z.string().max(120).optional() }).parse(req.query ?? {});
    const term = q?.trim();
    const riders = await ctx.prisma.rider.findMany({
      where: {
        memberships: { some: { businessId: merchant.businessId, status: "active" } },
        ...(term ? { OR: [{ name: { contains: term } }, { phone: { contains: term } }, { user: { email: { contains: term } } }] } : {}),
      },
      orderBy: { name: "asc" },
      take: 50,
      include: { merchantRiders: { where: { merchantId: auth.merchantId } } },
    });
    return {
      riders: riders.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        vehicle: r.vehicle,
        active: r.active,
        platformStatus: r.platformStatus,
        alreadyAttached: r.merchantRiders.some((m) => m.status === "active"),
      })),
    };
  });

  app.post("/api/merchant-portal/riders", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const merchant = await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: auth.merchantId }, select: { businessId: true } });
    const body = AddRiderBody.parse(req.body);
    const rider = await resolveRiderReference(body);
    if (!rider) throw httpErrors.createError(404, "No courier found matching that phone, email, or ID.");
    // Same business-membership check as search above — a merchant can only
    // attach a courier who already actively works for its own business,
    // never an arbitrary rider elsewhere on the platform. 404, not 403:
    // a merchant must never learn whether a given phone/email/id belongs
    // to a real rider at all outside its own business.
    const membership = await ctx.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId: rider.id, businessId: merchant.businessId } } });
    if (!membership || membership.status !== "active") throw httpErrors.createError(404, "No courier found matching that phone, email, or ID.");
    const existing = await ctx.prisma.merchantRider.findUnique({ where: { merchantId_riderId: { merchantId: auth.merchantId, riderId: rider.id } } });
    if (existing?.status === "active") throw httpErrors.createError(409, "This courier is already attached to your store.");
    await ctx.prisma.merchantRider.upsert({
      where: { merchantId_riderId: { merchantId: auth.merchantId, riderId: rider.id } },
      create: { merchantId: auth.merchantId, riderId: rider.id, status: "active", createdById: auth.userId, approvedAt: new Date() },
      update: { status: "active", createdById: auth.userId, approvedAt: new Date() },
    });
    const rel = await ctx.prisma.merchantRider.findUniqueOrThrow({ where: { merchantId_riderId: { merchantId: auth.merchantId, riderId: rider.id } } });
    await ctx.audit.record({ id: auth.userId, role: "merchant" }, "merchant.rider.add", "rider", rider.id, { merchantId: auth.merchantId });
    return { rider: merchantRiderDto(rider, rel.createdAt) };
  });

  app.delete<{ Params: { riderId: string } }>("/api/merchant-portal/riders/:riderId", async (req) => {
    const auth = await requireMerchantAuth(ctx, req);
    const rel = await ctx.prisma.merchantRider.findUnique({ where: { merchantId_riderId: { merchantId: auth.merchantId, riderId: req.params.riderId } } });
    if (!rel || rel.status !== "active") throw httpErrors.createError(404, "Courier not found in your roster.");
    await ctx.prisma.merchantRider.update({ where: { id: rel.id }, data: { status: "removed", approvedAt: null } });
    await ctx.audit.record({ id: auth.userId, role: "merchant" }, "merchant.rider.remove", "rider", req.params.riderId, { merchantId: auth.merchantId });
    return { ok: true };
  });
}

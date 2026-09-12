import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import { Prisma } from "@prisma/client";
import type { AppCtx } from "../ctx.js";
import { minorOf, money } from "@ronmacrae/money";
import type { GeoPoint, PublicOrderPricingDto, PublicOrderResultDto } from "@ronmacrae/contracts";
import { pointToJson } from "../geo-mappers.js";
import { deliveryPin } from "../lib/ids.js";
import { ZonesService } from "./zones.js";
import { FareEngine } from "./quotes.js";
import { CustomersService } from "./customers.js";
import { createTrackingLink } from "./jobs/history.js";
import { jobInclude, jobToDto, actorType, type Actor, type JobRow, type Viewer } from "./jobs/dto.js";
import { nextJobNumber, isUniqueViolation } from "./jobs/repository.js";
import { sendMerchantOrderEmail } from "./merchant-notify.js";

/**
 * The main public, no-login, no-app multi-item order form (spec section 5:
 * "PUBLIC CUSTOMER ORDER FORM — CRITICAL"). `/api/order` books against the
 * courier business's own default storefront (the single-store `/book`
 * form's richer successor — that older endpoint, `/api/delivery-requests`,
 * is untouched and still works); `/api/order/:merchantSlug` books against
 * that merchant. Every price shown to the customer is computed here,
 * server-side, from real data — never trusted from the request body (spec
 * section 13/59: "never trust a price sent only by the browser").
 */

const DEFAULT_PUBLIC_BUSINESS_SLUG = "ronmacrae";
/** Used only when no merchant (or a merchant with no pickup point set yet)
 *  is involved — the same address the staff "New Order" form defaults to.
 *  Geocoded at request time (the geo provider caches internally), not
 *  stored, so correcting it later needs no migration. */
const DEFAULT_PICKUP_ADDRESS = "15-17 Half Way Tree Road, Kingston, Jamaica";

const PointSchema = z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) });

const OrderItemInputSchema = z
  .object({
    productId: z.string().min(1).optional().nullable(),
    productVariantId: z.string().min(1).optional().nullable(),
    name: z.string().max(160).optional(),
    size: z.string().max(60).optional().nullable(),
    color: z.string().max(60).optional().nullable(),
    quantity: z.number().int().min(1).max(999),
    /** Only ever used for a free-text item with no catalog price at all — a
     *  catalog item's price is always the server's own product/variant
     *  record, this value is ignored for it. */
    unitPrice: z.number().min(0).max(10_000_000).optional().nullable(),
    notes: z.string().max(300).optional().nullable(),
  })
  .refine((v) => v.productId || v.productVariantId || (v.name && v.name.trim().length > 0), {
    message: "Each item needs either a catalog pick or a name",
  });

export const PublicOrderBody = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(7).max(20),
  email: z.string().email().max(160).optional().or(z.literal("")).nullable(),
  alternatePhone: z.string().max(20).optional().or(z.literal("")).nullable(),
  pickupAddressText: z.string().max(200).optional().or(z.literal("")).nullable(),
  addressText: z.string().min(3).max(200),
  addressProviderText: z.string().max(300).optional().or(z.literal("")).nullable(),
  landmark: z.string().max(120).optional().or(z.literal("")).nullable(),
  apartmentUnit: z.string().max(60).optional().or(z.literal("")).nullable(),
  point: PointSchema.optional().nullable(),
  items: z.array(OrderItemInputSchema).min(1).max(40),
  paymentMethod: z.enum(["cod", "online", "card", "transfer", "paid_at_store", "other"]).default("cod"),
  scheduledAt: z.coerce.date().optional().nullable(),
  instructions: z.string().max(500).optional().or(z.literal("")).nullable(),
  consentTracking: z.boolean().default(true),
});

const PublicQuoteBody = z.object({
  point: PointSchema.optional().nullable(),
  items: z.array(OrderItemInputSchema).min(1).max(40),
  merchantSlug: z.string().max(60).optional().nullable(),
});

interface ResolvedMerchantContext {
  businessId: string;
  merchantId: string | null;
  merchantName: string | null;
  pickupAddressText: string | null;
  pickupPoint: GeoPoint | null;
  currency: string;
}

/** Resolves which business (and, if a slug was given, which merchant of
 *  it) a public order/quote belongs to. Never guesses across businesses —
 *  an unknown/inactive merchant slug is a 404, same as everywhere else a
 *  business boundary is enforced. */
async function resolveContext(ctx: AppCtx, merchantSlug?: string | null): Promise<ResolvedMerchantContext> {
  if (merchantSlug) {
    const merchant = await ctx.prisma.merchant.findFirst({ where: { slug: merchantSlug, active: true } });
    if (!merchant) throw httpErrors.createError(404, "This order link isn't available");
    return {
      businessId: merchant.businessId,
      merchantId: merchant.id,
      merchantName: merchant.name,
      pickupAddressText: merchant.pickupAddressText,
      pickupPoint: merchant.pickupPoint ? (merchant.pickupPoint as unknown as GeoPoint) : null,
      currency: ctx.config.OPERATIONAL_CURRENCY,
    };
  }
  const business = await ctx.prisma.business.findUnique({ where: { slug: DEFAULT_PUBLIC_BUSINESS_SLUG } });
  if (!business) throw httpErrors.createError(503, "Ordering is not available right now");
  return {
    businessId: business.id,
    merchantId: null,
    merchantName: null,
    pickupAddressText: null,
    pickupPoint: null,
    currency: ctx.config.OPERATIONAL_CURRENCY,
  };
}

async function resolvePickupPoint(ctx: AppCtx, resolved: ResolvedMerchantContext): Promise<GeoPoint | null> {
  if (resolved.pickupPoint) return resolved.pickupPoint;
  const result = await ctx.geo.geocode(resolved.pickupAddressText || DEFAULT_PICKUP_ADDRESS);
  return result?.point ?? null;
}

type ResolvedItem = {
  productId: string | null;
  productVariantId: string | null;
  name: string;
  size: string | null;
  color: string | null;
  quantity: number;
  unitPriceMinor: number;
  notes: string | null;
};

/** Resolves each submitted item to a real, server-trusted price. A catalog
 *  pick (`productId`/`productVariantId`) always uses the actual stored
 *  product/variant price — a client-supplied `unitPrice` for one is
 *  ignored outright, never trusted as an override. A free-text item (no
 *  catalog pick) uses whatever price was typed, since there's no catalog
 *  price to check it against — same precedent the existing staff/public
 *  single-item flow already uses for "order value". */
async function resolveItems(
  ctx: AppCtx,
  merchantId: string | null,
  input: z.infer<typeof OrderItemInputSchema>[],
  currency: string,
): Promise<ResolvedItem[]> {
  const resolved: ResolvedItem[] = [];
  for (const item of input) {
    if (item.productVariantId || item.productId) {
      const variant = item.productVariantId
        ? await ctx.prisma.productVariant.findFirst({ where: { id: item.productVariantId }, include: { product: true } })
        : null;
      const product = variant?.product ?? (item.productId ? await ctx.prisma.product.findFirst({ where: { id: item.productId } }) : null);
      if (!product || (merchantId && product.merchantId !== merchantId)) {
        throw httpErrors.createError(404, "One of the items in this order is no longer available");
      }
      const unitPriceMinor = variant?.priceOverride ?? product.price;
      resolved.push({
        productId: product.id,
        productVariantId: variant?.id ?? null,
        name: item.name?.trim() || product.name,
        size: item.size ?? variant?.size ?? null,
        color: item.color ?? variant?.color ?? null,
        quantity: item.quantity,
        unitPriceMinor,
        notes: item.notes || null,
      });
    } else {
      resolved.push({
        productId: null,
        productVariantId: null,
        name: item.name!.trim(),
        size: item.size || null,
        color: item.color || null,
        quantity: item.quantity,
        unitPriceMinor: item.unitPrice != null ? minorOf(item.unitPrice, currency) : 0,
        notes: item.notes || null,
      });
    }
  }
  return resolved;
}

function summarize(items: ResolvedItem[]): { itemSummary: string; quantity: number; itemSize: string | null; itemColor: string | null } {
  const totalQty = items.reduce((s, it) => s + it.quantity, 0);
  const summary = items.map((it) => (it.quantity > 1 ? `${it.quantity}× ${it.name}` : it.name)).join(", ");
  return {
    itemSummary: summary.slice(0, 200),
    quantity: totalQty,
    // Only meaningful for a genuinely single-item order — a multi-item
    // order's real per-line size/colour lives on each JobItem instead.
    itemSize: items.length === 1 ? items[0]!.size : null,
    itemColor: items.length === 1 ? items[0]!.color : null,
  };
}

async function computePricing(
  ctx: AppCtx,
  resolved: ResolvedMerchantContext,
  items: ResolvedItem[],
  destination: GeoPoint | null,
): Promise<{ pricing: PublicOrderPricingDto; feeMinor: number | null; zoneId: string | null }> {
  const cur = resolved.currency;
  const subtotalMinor = items.reduce((s, it) => s + it.unitPriceMinor * it.quantity, 0);
  const zones = new ZonesService(ctx);
  let feeMinor: number | null = null;
  let zoneId: string | null = null;
  if (destination) {
    const zone = await zones.detect(resolved.businessId, destination);
    zoneId = zone.zoneId;
    const pickup = await resolvePickupPoint(ctx, resolved);
    if (pickup) {
      try {
        const quote = await new FareEngine(ctx, zones).quote(resolved.businessId, { fromPoint: pickup, toPoint: destination });
        feeMinor = quote.fee.amount;
      } catch {
        feeMinor = null;
      }
    }
  }
  const subtotal = money(subtotalMinor, cur);
  const deliveryFeeConfirmed = feeMinor != null;
  const deliveryFee = feeMinor != null ? money(feeMinor, cur) : null;
  const total = money(subtotalMinor + (feeMinor ?? 0), cur);
  return { pricing: { subtotal, deliveryFee, deliveryFeeConfirmed, total }, feeMinor, zoneId };
}

export async function orderRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const rateLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  // Side-effect-free price preview — shown before "Place order" (spec
  // section 76/77). The real submission recomputes the same thing
  // independently; this is a convenience, never the source of truth.
  app.post("/api/order/quote", rateLimit, async (req) => {
    const body = PublicQuoteBody.parse(req.body);
    const resolved = await resolveContext(ctx, body.merchantSlug);
    const items = await resolveItems(ctx, resolved.merchantId, body.items, resolved.currency);
    const { pricing } = await computePricing(ctx, resolved, items, body.point ?? null);
    return pricing;
  });

  async function handleCreate(req: { body: unknown }, merchantSlug: string | null): Promise<PublicOrderResultDto> {
    const body = PublicOrderBody.parse(req.body);
    const resolved = await resolveContext(ctx, merchantSlug);
    const items = await resolveItems(ctx, resolved.merchantId, body.items, resolved.currency);
    const { pricing, feeMinor, zoneId } = await computePricing(ctx, resolved, items, body.point ?? null);

    const customer = await new CustomersService(ctx).upsertFromRequest(resolved.businessId, {
      name: body.name,
      phone: body.phone,
      email: body.email || null,
      addressText: body.addressText,
      point: body.point ?? null,
      consentTracking: body.consentTracking,
    });

    const { itemSummary, quantity, itemSize, itemColor } = summarize(items);
    const cod = body.paymentMethod === "cod";
    const subtotalMinor = items.reduce((s, it) => s + it.unitPriceMinor * it.quantity, 0);
    const totalMinor = subtotalMinor + (feeMinor ?? 0);
    const actor: Actor = { id: null, name: body.name, role: "customer", businessId: resolved.businessId };
    const viewer: Viewer = { role: "anonymous", riderId: null, businessId: resolved.businessId };

    let row: JobRow | null = null;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      try {
        row = await ctx.prisma.$transaction(async (tx) => {
          const job = await tx.job.create({
            data: {
              businessId: resolved.businessId,
              merchantId: resolved.merchantId,
              jobNumber: await nextJobNumber(ctx, resolved.businessId),
              source: "web",
              customerId: customer.id,
              type: "delivery",
              status: "new",
              priority: "normal",
              addressText: body.addressText,
              addressProviderText: body.addressProviderText || null,
              landmark: [body.landmark, body.apartmentUnit].filter(Boolean).join(" · ") || null,
              point: pointToJson(body.point ?? null) ?? Prisma.JsonNull,
              pickupPoint: pointToJson(await resolvePickupPoint(ctx, resolved)) ?? Prisma.JsonNull,
              pickupAddressText: resolved.pickupAddressText || DEFAULT_PICKUP_ADDRESS,
              itemSummary,
              quantity,
              itemSize,
              itemColor,
              instructions: body.instructions || null,
              zoneId,
              fare: subtotalMinor,
              fee: feeMinor,
              subtotal: totalMinor,
              currency: resolved.currency,
              paymentMethod: body.paymentMethod,
              paymentStatus: cod ? "unpaid" : "paid",
              pin: deliveryPin(ctx.config.PIN_LENGTH),
              amountExpected: totalMinor,
              amountCollected: 0,
              scheduledAt: body.scheduledAt ?? null,
              items: {
                create: items.map((it) => ({
                  productId: it.productId,
                  productVariantId: it.productVariantId,
                  name: it.name,
                  size: it.size,
                  color: it.color,
                  quantity: it.quantity,
                  unitPrice: it.unitPriceMinor,
                  currency: resolved.currency,
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
              actorType: actorType("customer"),
              actorId: null,
              actorName: body.name,
              note: null,
              meta: { source: "web", merchantId: resolved.merchantId, itemCount: items.length } as object,
            },
          });
          return job;
        });
      } catch (err) {
        if (!isUniqueViolation(err) || attempt === 4) throw err;
      }
    }
    if (!row) throw httpErrors.createError(409, "Could not allocate a job number");

    const link = await createTrackingLink(ctx, row.id, viewer);
    await ctx.audit.record(actor, "order.create", "job", row.id, { merchantId: resolved.merchantId, itemCount: items.length });

    // Never blocks the customer's own confirmation on the merchant email —
    // send it, but a slow/failing provider must not fail the order itself.
    if (resolved.merchantId) {
      void sendMerchantOrderEmail(ctx, row.id).catch((err) => ctx.log.error({ err: String(err), jobId: row!.id }, "merchant order email failed"));
    }

    const dto = jobToDto(row, viewer, ctx.config.APP_ORIGIN);
    return {
      jobId: row.id,
      jobNumber: row.jobNumber,
      merchantName: resolved.merchantName,
      customerName: customer.name,
      items: dto.items,
      pricing,
      scheduledAt: dto.scheduledAt,
      tracking: link,
    };
  }

  app.post("/api/order", rateLimit, async (req) => handleCreate(req, null));
  app.post<{ Params: { merchantSlug: string } }>("/api/order/:merchantSlug", rateLimit, async (req) => handleCreate(req, req.params.merchantSlug));
}

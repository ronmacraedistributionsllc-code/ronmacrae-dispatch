import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import { Prisma } from "@prisma/client";
import type { AppCtx } from "../../ctx.js";
import { minorOf } from "@ronmacrae/money";
import type { GeoPoint, JobDto } from "@ronmacrae/contracts";
import { JOB_SOURCES } from "@ronmacrae/contracts";
import { pointToJson } from "../../geo-mappers.js";
import { deliveryPin } from "../../lib/ids.js";
import { ZonesService } from "../zones.js";
import { FareEngine } from "../quotes.js";
import { actorType, jobInclude, jobToDto, type Actor, type JobRow, type Viewer } from "./dto.js";
import { isUniqueViolation, nextJobNumber, returnJobFor } from "./repository.js";

const PointSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

const MoneyMajor = z.number().min(0).max(10_000_000);

export const CreateJobBody = z.object({
  customerId: z.string().min(1),
  type: z.enum(["pickup", "delivery", "pickup_delivery", "return"]).default("delivery"),
  priority: z.enum(["normal", "express", "urgent"]).default("normal"),
  source: z.enum(JOB_SOURCES).default("manual"),
  externalRef: z.string().max(80).optional().or(z.literal("")).nullable().default(""),
  addressText: z.string().max(200).optional().or(z.literal("")).nullable().default(""),
  /** Geocoder's formatted match, if any — informational only, never overrides addressText. */
  addressProviderText: z.string().max(300).optional().or(z.literal("")).nullable().default(""),
  landmark: z.string().max(120).optional().or(z.literal("")).nullable().default(""),
  point: PointSchema.optional().nullable(),
  pickupPoint: PointSchema.optional().nullable(),
  pickupAddressText: z.string().max(200).optional().or(z.literal("")).nullable().default(""),
  pickupAddressProviderText: z.string().max(300).optional().or(z.literal("")).nullable().default(""),
  pickupContact: z.string().max(80).optional().or(z.literal("")).nullable().default(""),
  itemSummary: z.string().max(200).optional().or(z.literal("")).nullable().default(""),
  quantity: z.number().int().min(1).max(999).default(1),
  itemSize: z.string().max(80).optional().or(z.literal("")).nullable().default(""),
  itemColor: z.string().max(80).optional().or(z.literal("")).nullable().default(""),
  packageSize: z.string().max(40).optional().or(z.literal("")).nullable().default(""),
  instructions: z.string().max(500).optional().or(z.literal("")).nullable().default(""),
  vehicle: z.enum(["motorcycle", "car"]).optional().nullable(),
  /** product value (major units) */
  fare: MoneyMajor.optional(),
  /** delivery fee override (major units); when omitted it is quoted from the zones */
  fee: MoneyMajor.optional(),
  paymentMethod: z.enum(["cod", "online", "card", "transfer"]).default("cod"),
  pin: z.string().regex(/^\d{4,10}$/).optional(),
  scheduledAt: z.coerce.date().optional(),
  promisedAt: z.coerce.date().optional(),
});

export const UpdateJobBody = z.object({
  priority: z.enum(["normal", "express", "urgent"]).optional(),
  addressText: z.string().max(200).optional().or(z.literal("")).nullable(),
  addressProviderText: z.string().max(300).optional().or(z.literal("")).nullable(),
  landmark: z.string().max(120).optional().or(z.literal("")).nullable(),
  point: PointSchema.optional().nullable(),
  pickupPoint: PointSchema.optional().nullable(),
  pickupAddressText: z.string().max(200).optional().or(z.literal("")).nullable(),
  pickupAddressProviderText: z.string().max(300).optional().or(z.literal("")).nullable(),
  pickupContact: z.string().max(80).optional().or(z.literal("")).nullable(),
  itemSummary: z.string().max(200).optional().or(z.literal("")).nullable(),
  quantity: z.number().int().min(1).max(999).optional().nullable(),
  itemSize: z.string().max(80).optional().or(z.literal("")).nullable(),
  itemColor: z.string().max(80).optional().or(z.literal("")).nullable(),
  packageSize: z.string().max(40).optional().or(z.literal("")).nullable(),
  instructions: z.string().max(500).optional().or(z.literal("")).nullable(),
  vehicle: z.enum(["motorcycle", "car"]).optional().nullable(),
  fare: MoneyMajor.optional().nullable(),
  fee: MoneyMajor.optional().nullable(),
  paymentMethod: z.enum(["cod", "online", "card", "transfer"]).optional(),
  pin: z.string().regex(/^\d{4,10}$/).optional(),
  scheduledAt: z.coerce.date().optional().nullable(),
  promisedAt: z.coerce.date().optional().nullable(),
});

export type CreateJobInput = z.infer<typeof CreateJobBody>;
export type UpdateJobInput = z.infer<typeof UpdateJobBody>;

export function viewerFor(req: { user: { role: string; riderId?: string } | null }): Viewer {
  return { role: req.user?.role ?? "anonymous", riderId: req.user?.riderId ?? null };
}

export async function createJob(
  ctx: AppCtx,
  body: CreateJobInput,
  actor: Actor,
  viewer: Viewer,
): Promise<JobDto> {
  const cur = ctx.config.OPERATIONAL_CURRENCY;
  const customer = await ctx.prisma.customer.findUnique({ where: { id: body.customerId } });
  if (!customer) throw httpErrors.createError(404, "Customer not found");
  if (body.externalRef) {
    const dup = await ctx.prisma.job.findFirst({ where: { externalRef: body.externalRef }, select: { id: true } });
    if (dup) throw httpErrors.createError(409, `A job with external reference ${body.externalRef} already exists`);
  }

  // fee: explicit override wins; otherwise quote store->drop-off when both points exist
  let feeMinor: number | null = null;
  if (body.fee != null) {
    feeMinor = minorOf(body.fee, cur);
  } else if (body.pickupPoint && body.point) {
    try {
      const quote = await new FareEngine(ctx, new ZonesService(ctx)).quote({
        fromPoint: body.pickupPoint as GeoPoint,
        toPoint: body.point as GeoPoint,
        express: body.priority === "express",
        urgent: body.priority === "urgent",
      });
      feeMinor = quote.fee.amount;
    } catch {
      feeMinor = null; // no routing available - dispatcher can set the fee later
    }
  }
  const fareMinor = body.fare != null ? minorOf(body.fare, cur) : null;
  const subtotal = fareMinor != null || feeMinor != null ? (fareMinor ?? 0) + (feeMinor ?? 0) : null;
  const cod = body.paymentMethod === "cod";

  const zones = new ZonesService(ctx);
  const zone = body.point ? await zones.detect(body.point as GeoPoint) : { zoneId: null, zoneName: null };

  const data = {
    jobNumber: "",
    externalRef: body.externalRef || null,
    source: body.source,
    customerId: customer.id,
    type: body.type,
    status: "new" as const,
    priority: body.priority,
    addressText: body.addressText || null,
    addressProviderText: body.addressProviderText || null,
    landmark: body.landmark || null,
    point: pointToJson(body.point ?? null) ?? Prisma.JsonNull,
    pickupPoint: pointToJson(body.pickupPoint ?? null) ?? Prisma.JsonNull,
    pickupAddressText: body.pickupAddressText || null,
    pickupAddressProviderText: body.pickupAddressProviderText || null,
    pickupContact: body.pickupContact || null,
    itemSummary: body.itemSummary || null,
    quantity: body.quantity,
    itemSize: body.itemSize || null,
    itemColor: body.itemColor || null,
    packageSize: body.packageSize || null,
    instructions: body.instructions || null,
    zoneId: zone.zoneId,
    vehicle: body.vehicle ?? null,
    fare: fareMinor,
    fee: feeMinor,
    subtotal,
    currency: cur,
    paymentMethod: body.paymentMethod,
    paymentStatus: cod ? ("unpaid" as const) : ("paid" as const),
    pin: body.pin ?? deliveryPin(ctx.config.PIN_LENGTH),
    amountExpected: subtotal,
    amountCollected: 0,
    riderId: null,
    scheduledAt: body.scheduledAt ?? null,
    promisedAt: body.promisedAt ?? null,
    completedAt: null,
  };

  let row: JobRow | null = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    try {
      row = await ctx.prisma.$transaction(async (tx) => {
        const job = await tx.job.create({
          data: { ...data, jobNumber: await nextJobNumber(ctx) },
          include: jobInclude,
        });
        await tx.jobEvent.create({
          data: {
            jobId: job.id,
            from: null,
            to: "new",
            actorType: actorType(actor.role),
            actorId: actor.id,
            actorName: actor.name,
            note: null,
            meta: { source: body.source, externalRef: body.externalRef || null } as object,
          },
        });
        return job;
      });
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 4) throw err;
      // jobNumber collision - retry with a fresh number
    }
  }
  if (!row) throw httpErrors.createError(409, "Could not allocate a job number");

  const returnJobId = await returnJobFor(ctx, row.id);
  return jobToDto(row, viewer, ctx.config.APP_ORIGIN, { returnJobId });
}

/** Staff edit of a job's fields (address, items, pricing, schedule). */
export async function updateJob(
  ctx: AppCtx,
  id: string,
  body: UpdateJobInput,
  actor: Actor,
  viewer: Viewer,
): Promise<JobDto> {
  const cur = ctx.config.OPERATIONAL_CURRENCY;
  const existing = await ctx.prisma.job.findUnique({ where: { id } });
  if (!existing) throw httpErrors.createError(404, "Job not found");

  const fareMinor = body.fare === undefined ? existing.fare : body.fare == null ? null : minorOf(body.fare, cur);
  const feeMinor = body.fee === undefined ? existing.fee : body.fee == null ? null : minorOf(body.fee, cur);
  const subtotal =
    fareMinor != null || feeMinor != null ? (fareMinor ?? 0) + (feeMinor ?? 0) : existing.subtotal;
  const point =
    body.point === undefined ? undefined : (pointToJson(body.point ?? null) ?? Prisma.JsonNull);

  let zoneId = existing.zoneId;
  if (body.point !== undefined) {
    const zone = await new ZonesService(ctx).detect(body.point as GeoPoint | null);
    zoneId = zone.zoneId;
  }

  const row = await ctx.prisma.$transaction(async (tx) => {
    const job = await tx.job.update({
      where: { id },
      include: jobInclude,
      data: {
        priority: body.priority,
        addressText: body.addressText === undefined ? undefined : body.addressText || null,
        addressProviderText: body.addressProviderText === undefined ? undefined : body.addressProviderText || null,
        landmark: body.landmark === undefined ? undefined : body.landmark || null,
        point,
        pickupPoint: body.pickupPoint === undefined ? undefined : (pointToJson(body.pickupPoint ?? null) ?? Prisma.JsonNull),
        pickupAddressText: body.pickupAddressText === undefined ? undefined : body.pickupAddressText || null,
        pickupAddressProviderText: body.pickupAddressProviderText === undefined ? undefined : body.pickupAddressProviderText || null,
        pickupContact: body.pickupContact === undefined ? undefined : body.pickupContact || null,
        itemSummary: body.itemSummary === undefined ? undefined : body.itemSummary || null,
        quantity: body.quantity,
        itemSize: body.itemSize === undefined ? undefined : body.itemSize || null,
        itemColor: body.itemColor === undefined ? undefined : body.itemColor || null,
        packageSize: body.packageSize === undefined ? undefined : body.packageSize || null,
        instructions: body.instructions === undefined ? undefined : body.instructions || null,
        vehicle: body.vehicle,
        zoneId,
        fare: fareMinor,
        fee: feeMinor,
        subtotal,
        paymentMethod: body.paymentMethod,
        pin: body.pin,
        scheduledAt: body.scheduledAt,
        promisedAt: body.promisedAt,
      },
    });
    const changed = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    await tx.jobEvent.create({
      data: {
        jobId: id,
        from: existing.status,
        to: existing.status,
        actorType: actorType(actor.role),
        actorId: actor.id,
        actorName: actor.name,
        note: "details updated",
        meta: { changed } as object,
      },
    });
    return job;
  });

  return jobToDto(row, viewer, ctx.config.APP_ORIGIN, { returnJobId: await returnJobFor(ctx, id) });
}

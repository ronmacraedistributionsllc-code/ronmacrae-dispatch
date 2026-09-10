import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppCtx } from "../ctx.js";
import type { DeliveryRequestResultDto } from "@ronmacrae/contracts";
import { CreateJobBody, createJob } from "./jobs/create.js";
import { createTrackingLink } from "./jobs/history.js";
import { CustomersService } from "./customers.js";

const PointSchema = z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) });
const MoneyMajor = z.number().min(0).max(10_000_000);

/**
 * Public "book a delivery" form (the store's customer, no auth).
 * Kept deliberately small: contact, destination, product, payment and timing.
 */
export const DeliveryRequestBody = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(7).max(20),
  email: z.string().email().max(120).optional().or(z.literal("")).nullable().default(""),
  pickupAddressText: z.string().max(200).optional().or(z.literal("")).nullable().default(""),
  addressText: z.string().max(200).min(3).optional().or(z.literal("")).nullable().default(""),
  landmark: z.string().max(120).optional().or(z.literal("")).nullable().default(""),
  point: PointSchema.optional().nullable(),
  itemSummary: z.string().max(200).optional().or(z.literal("")).nullable().default(""),
  quantity: z.number().int().min(1).max(999).default(1),
  itemSize: z.string().max(80).optional().or(z.literal("")).nullable().default(""),
  itemColor: z.string().max(80).optional().or(z.literal("")).nullable().default(""),
  fare: MoneyMajor.optional().nullable(),
  fee: MoneyMajor.optional().nullable(),
  paymentMethod: z.enum(["cod", "online"]).default("cod"),
  scheduledAt: z.coerce.date().optional().nullable(),
  instructions: z.string().max(500).optional().or(z.literal("")).nullable().default(""),
  consentTracking: z.boolean().default(true),
});

/** Public delivery request: upserts the customer, books the job, returns the tracking link. */
export async function deliveryRequestRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post("/api/delivery-requests", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = DeliveryRequestBody.parse(req.body);
    const customer = await new CustomersService(ctx).upsertFromRequest({
      name: body.name,
      phone: body.phone,
      email: body.email || null,
      addressText: body.addressText || null,
      point: body.point ?? null,
      consentTracking: body.consentTracking,
    });

    const jobBody = CreateJobBody.parse({
      customerId: customer.id,
      type: "delivery",
      priority: "normal",
      source: "web",
      addressText: body.addressText,
      landmark: body.landmark,
      point: body.point ?? null,
      pickupAddressText: body.pickupAddressText,
      itemSummary: body.itemSummary,
      quantity: body.quantity,
      itemSize: body.itemSize,
      itemColor: body.itemColor,
      fare: body.fare ?? undefined,
      fee: body.fee ?? undefined,
      paymentMethod: body.paymentMethod,
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
      instructions: body.instructions,
    });
    const actor = { id: null, name: body.name, role: "customer" };
    const job = await createJob(ctx, jobBody, actor, { role: "anonymous", riderId: null });

    // the customer gets a tracking link immediately (idempotent per job)
    const link = await createTrackingLink(ctx, job.id);

    const out: DeliveryRequestResultDto = {
      jobId: job.id,
      jobNumber: job.jobNumber,
      customerName: job.customerName,
      tracking: link,
    };
    return out;
  });
}

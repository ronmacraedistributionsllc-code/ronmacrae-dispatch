import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import type { BusinessSettings } from "@ronmacrae/contracts";

const BusinessSettingsBody = z.object({
  businessName: z.string().min(1).max(120),
  dispatchPhone: z.string().max(20).default(""),
  dispatchWhatsApp: z.string().max(20).default(""),
  dispatchNotificationEmail: z.string().email().optional().or(z.literal("")).default(""),
  operationalCurrency: z.enum(["JMD", "USD", "BBD", "CAD"]).default("JMD"),
  usdToJmdRate: z.number().positive().max(10_000).nullable().default(null),
  defaultZoneId: z.string().nullable().default(null),
  pinLength: z.number().int().min(4).max(10).default(4),
  trackingLinkTtlHours: z.number().positive().max(720).default(72),
  nativeAppRecommended: z.boolean().default(true),
});

/** Business settings now live directly on the Business row (multi-tenancy,
 *  Stage 20) — every caller is scoped to one businessId, never a global
 *  singleton. Falls back to safe defaults only for fields the row itself
 *  leaves null (dispatch contact, USD rate). */
export async function getBusinessSettings(app: AppCtx, businessId: string): Promise<BusinessSettings> {
  const row = await app.prisma.business.findUnique({ where: { id: businessId } });
  if (!row) throw httpErrors.createError(404, "Business not found");
  return {
    businessName: row.name,
    dispatchPhone: row.dispatchPhone ?? "",
    dispatchWhatsApp: row.dispatchWhatsApp ?? "",
    dispatchNotificationEmail: row.dispatchNotificationEmail ?? "",
    operationalCurrency: row.operationalCurrency,
    usdToJmdRate: row.usdToJmdRate ?? app.config.USD_TO_JMD_RATE,
    defaultZoneId: row.defaultZoneId,
    pinLength: row.pinLength,
    trackingLinkTtlHours: row.trackingLinkTtlHours,
    nativeAppRecommended: row.nativeAppRecommended,
  };
}

export async function settingsRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/settings/business", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    return { settings: await getBusinessSettings(ctx, req.user!.businessId!) };
  });

  app.put("/api/settings/business", { preHandler: ctx.requireStaff("admin") }, async (req) => {
    const body = BusinessSettingsBody.parse(req.body);
    const businessId = req.user!.businessId!;
    await ctx.prisma.business.update({
      where: { id: businessId },
      data: {
        name: body.businessName,
        dispatchPhone: body.dispatchPhone || null,
        dispatchWhatsApp: body.dispatchWhatsApp || null,
        dispatchNotificationEmail: body.dispatchNotificationEmail || null,
        operationalCurrency: body.operationalCurrency,
        usdToJmdRate: body.usdToJmdRate,
        defaultZoneId: body.defaultZoneId,
        pinLength: body.pinLength,
        trackingLinkTtlHours: body.trackingLinkTtlHours,
        nativeAppRecommended: body.nativeAppRecommended,
      },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "settings.business_update", "setting", "business");
    return { settings: body };
  });
}

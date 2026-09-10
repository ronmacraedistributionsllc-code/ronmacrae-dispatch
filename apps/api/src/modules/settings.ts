import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import type { BusinessSettings } from "@ronmacrae/contracts";

const BusinessSettingsBody = z.object({
  businessName: z.string().min(1).max(120),
  dispatchPhone: z.string().max(20).default(""),
  dispatchWhatsApp: z.string().max(20).default(""),
  operationalCurrency: z.enum(["JMD", "USD", "BBD", "CAD"]).default("JMD"),
  usdToJmdRate: z.number().positive().max(10_000).nullable().default(null),
  defaultZoneId: z.string().nullable().default(null),
  pinLength: z.number().int().min(4).max(10).default(4),
  trackingLinkTtlHours: z.number().positive().max(720).default(72),
  nativeAppRecommended: z.boolean().default(true),
});

/** Business blob with safe defaults so every flow works on a fresh DB. */
export async function getBusinessSettings(app: AppCtx): Promise<BusinessSettings> {
  const row = await app.prisma.setting.findUnique({ where: { key: "business" } });
  const v = (row?.value ?? {}) as Partial<BusinessSettings>;
  return {
    businessName: v.businessName ?? "Ronmacrae Distributions",
    dispatchPhone: v.dispatchPhone ?? "",
    dispatchWhatsApp: v.dispatchWhatsApp ?? "",
    operationalCurrency: v.operationalCurrency ?? app.config.OPERATIONAL_CURRENCY,
    usdToJmdRate: v.usdToJmdRate ?? app.config.USD_TO_JMD_RATE,
    defaultZoneId: v.defaultZoneId ?? null,
    pinLength: v.pinLength ?? app.config.PIN_LENGTH,
    trackingLinkTtlHours: v.trackingLinkTtlHours ?? app.config.TRACKING_LINK_TTL_HOURS,
    nativeAppRecommended: v.nativeAppRecommended ?? true,
  };
}

export async function settingsRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/settings/business", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async () => {
    return { settings: await getBusinessSettings(ctx) };
  });

  app.put("/api/settings/business", { preHandler: ctx.requireStaff("admin") }, async (req) => {
    const body = BusinessSettingsBody.parse(req.body);
    const settings: BusinessSettings = body;
    await ctx.prisma.setting.upsert({
      where: { key: "business" },
      create: { key: "business", value: settings as unknown as object },
      update: { value: settings as unknown as object },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "settings.business_update", "setting", "business");
    return { settings };
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppCtx } from "../ctx.js";
import { minorOf, money, type Money } from "@ronmacrae/money";
import type { FareQuoteDto, FareQuoteRequest } from "@ronmacrae/contracts";
import { ZonesService } from "./zones.js";

/**
 * Delivery fee engine.
 * Base: zone-pair fare rule if set, else destination zone base + per-km.
 * Surcharges: express +25%, heavy (>15kg) +20%, night (22:00-05:00) +15%.
 * All values in the operational currency (JMD default, USD supported).
 */
export class FareEngine {
  constructor(
    private readonly app: AppCtx,
    private readonly zones: ZonesService,
  ) {}

  async quote(req: FareQuoteRequest): Promise<FareQuoteDto> {
    const cur = this.app.config.OPERATIONAL_CURRENCY;
    const fromZone = await this.zones.detect(req.fromPoint);
    const toZone = await this.zones.detect(req.toPoint);

    const route = await this.app.geo.route([req.fromPoint, req.toPoint], "car");
    const km = route.totalDistanceM / 1000;

    const breakdown: { label: string; amount: Money }[] = [];
    let fee = minorOf(0, cur);

    const rule =
      fromZone.zoneId && toZone.zoneId
        ? await this.app.prisma.fareRule.findFirst({
            where: { fromZoneId: fromZone.zoneId, toZoneId: toZone.zoneId, validFrom: { lte: new Date() } },
          })
        : null;

    if (rule) {
      fee = rule.fee;
      if (rule.minFee != null && fee < rule.minFee) fee = rule.minFee;
      breakdown.push({ label: `Zone rate (${fromZone.zoneName ?? "?"} → ${toZone.zoneName ?? "?"})`, amount: money(fee, cur) });
    } else {
      const zoneFees = await this.zones.zoneFees(toZone.zoneId, route.totalDistanceM || null, cur);
      if (zoneFees.fee != null) {
        fee = zoneFees.fee;
        breakdown.push({ label: `Zone base + distance (${toZone.zoneName ?? "outside zones"})`, amount: money(fee, cur) });
      } else {
        // no zone data: flat estimate from distance
        fee = minorOf(Math.max(1, Math.round(km * 15)), cur);
        breakdown.push({ label: "Distance estimate (no zone data)", amount: money(fee, cur) });
      }
    }

    let surcharge = 0;
    if (req.express) {
      surcharge += 0.25;
      breakdown.push({ label: "Express", amount: money(Math.round(fee * 0.25), cur) });
    }
    if (req.heavy || (req.weightKg ?? 0) > 15) {
      surcharge += 0.2;
      breakdown.push({ label: "Heavy item", amount: money(Math.round(fee * 0.2), cur) });
    }
    const hour = new Date().getHours();
    if (hour >= 22 || hour < 5) {
      surcharge += 0.15;
      breakdown.push({ label: "Night", amount: money(Math.round(fee * 0.15), cur) });
    }
    if (surcharge > 0) fee = Math.round(fee * (1 + surcharge));

    // Urgent: a flat per-zone surcharge (not a percentage), set by the owner/admin
    // on the destination zone. Applied after the percentage surcharges above, on
    // top of the (already-surcharged) fee, since it's a separate flat add-on.
    if (req.urgent && toZone.zoneId) {
      const zone = await this.app.prisma.zone.findUnique({ where: { id: toZone.zoneId } });
      if (zone?.urgentSurchargeFee) {
        fee += zone.urgentSurchargeFee;
        breakdown.push({ label: "Urgent delivery", amount: money(zone.urgentSurchargeFee, cur) });
      }
    }

    return {
      fare: money(0, cur), // product fare is supplied by the caller (order value)
      fee: money(fee, cur),
      subtotal: money(fee, cur),
      breakdown,
      distanceM: route.totalDistanceM || null,
      durationS: route.totalDurationS || null,
      routingProvider: this.app.geo.name,
    };
  }
}

export const QuoteBody = z.object({
  fromPoint: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }),
  toPoint: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }),
  fromZoneId: z.string().optional().nullable(),
  toZoneId: z.string().optional().nullable(),
  express: z.boolean().default(false),
  heavy: z.boolean().default(false),
  weightKg: z.number().min(0).max(1000).optional(),
  urgent: z.boolean().default(false),
});

export async function quoteRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const engine = new FareEngine(ctx, new ZonesService(ctx));
  app.post("/api/quotes", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = QuoteBody.parse(req.body);
    return engine.quote(body as FareQuoteRequest);
  });
}

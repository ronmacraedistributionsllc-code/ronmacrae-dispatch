import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppCtx } from "../ctx.js";
import type { GeoSuggestionDto } from "@ronmacrae/contracts";

const SearchBody = z.object({
  query: z.string().min(2).max(200),
  bias: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }).optional(),
  limit: z.number().int().min(1).max(10).default(5),
});

const ReverseBody = z.object({
  point: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }),
});

/**
 * Public (rate-limited) address search, used by the address-first order-creation
 * flow's "type an address, pick a suggestion, confirm the pin" UI. `/api/geo/geocode`
 * and `/api/geo/reverse` are both allowlisted as unauthenticated in
 * modules/auth.ts's registerAuthHook — a customer on the public booking form needs
 * this exactly as much as staff on the New Order form.
 */
export async function geoRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post("/api/geo/geocode", async (req) => {
    const body = SearchBody.parse(req.body);
    const results = await ctx.geo.searchAddresses(body.query, body.bias, body.limit);
    const degraded = results.length > 0 && results.every((r) => r.provider === "simulated");
    return { results: results as GeoSuggestionDto[], degraded };
  });

  app.post("/api/geo/reverse", async (req) => {
    const body = ReverseBody.parse(req.body);
    const label = await ctx.geo.reverseGeocode(body.point);
    return { label };
  });
}

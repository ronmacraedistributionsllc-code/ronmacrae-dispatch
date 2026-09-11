import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { minorOf, money, majorOf, currencyMeta } from "@ronmacrae/money";
import type { GeoPoint, ZoneDto, ZoneGeometry } from "@ronmacrae/contracts";
import { pointInZone, squareZoneGeometry } from "@ronmacrae/geo";
import { zoneToDto } from "../geo-mappers.js";

export const GeometrySchema = z
  .object({
    type: z.enum(["Polygon", "MultiPolygon"]),
    coordinates: z.any(),
  })
  .refine((g) => Array.isArray(g.coordinates) && g.coordinates.length > 0, { message: "geometry must have coordinates" });

const PointSchema = z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) });

const CreateZone = z
  .object({
    name: z.string().min(1).max(80),
    parish: z.string().max(40).optional().or(z.literal("")),
    /** Either a full polygon, or a center point + radius to auto-generate a simple
     *  square zone (same shape apps/api/src/seed.ts uses for the seeded zones) —
     *  the admin UI's address picker supplies `center`, not a hand-drawn polygon. */
    geometry: GeometrySchema.optional(),
    center: PointSchema.optional(),
    radiusKm: z.number().min(0.5).max(50).default(3),
    baseFee: z.number().min(0).max(1_000_000),
    perKmFee: z.number().min(0).max(1_000_000).optional(),
    urgentSurchargeFee: z.number().min(0).max(1_000_000).optional(),
    active: z.boolean().default(true),
  })
  .refine((v) => v.geometry || v.center, { message: "geometry or center is required" });

const UpdateZone = z.object({
  name: z.string().min(1).max(80).optional(),
  parish: z.string().max(40).optional().or(z.literal("")),
  geometry: GeometrySchema.optional(),
  center: PointSchema.optional(),
  radiusKm: z.number().min(0.5).max(50).optional(),
  baseFee: z.number().min(0).max(1_000_000).optional(),
  perKmFee: z.number().min(0).max(1_000_000).optional().nullable(),
  urgentSurchargeFee: z.number().min(0).max(1_000_000).optional().nullable(),
  active: z.boolean().optional(),
});

/** Every method is scoped to one business — a zone (and the fees it carries)
 *  belongs to exactly the business that configured it, same as jobs/customers. */
export class ZonesService {
  constructor(
    private readonly app: Pick<AppCtx, "prisma" | "geo" | "config">,
  ) {}

  /** Point-in-polygon over this business's own active zones. */
  async detect(businessId: string, point: GeoPoint | null): Promise<{ zoneId: string | null; zoneName: string | null }> {
    if (!point) return { zoneId: null, zoneName: null };
    const zones = await this.app.prisma.zone.findMany({ where: { businessId, active: true } });
    for (const z of zones) {
      try {
        if (pointInZone(point, z.geometry as unknown as ZoneGeometry)) {
          return { zoneId: z.id, zoneName: z.name };
        }
      } catch {
        // malformed geometry - skip
      }
    }
    return { zoneId: null, zoneName: null };
  }

  async list(businessId: string): Promise<ZoneDto[]> {
    const rows = await this.app.prisma.zone.findMany({ where: { businessId }, orderBy: { name: "asc" } });
    return rows.map(zoneToDto);
  }

  async get(businessId: string, id: string) {
    const z = await this.app.prisma.zone.findFirst({ where: { id, businessId } });
    return z ? zoneToDto(z) : null;
  }

  async create(businessId: string, input: z.infer<typeof CreateZone>, currency: string) {
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const exists = await this.app.prisma.zone.findUnique({ where: { businessId_slug: { businessId, slug } } });
    if (exists) throw httpErrors.createError(409, "Zone name already exists");
    const geometry = input.geometry ?? squareZoneGeometry(input.center!, input.radiusKm);
    const zone = await this.app.prisma.zone.create({
      data: {
        businessId,
        name: input.name,
        slug,
        parish: input.parish || null,
        geometry: geometry as object,
        baseFee: minorOf(input.baseFee, currency),
        perKmFee: input.perKmFee != null ? minorOf(input.perKmFee, currency) : null,
        urgentSurchargeFee: input.urgentSurchargeFee != null ? minorOf(input.urgentSurchargeFee, currency) : null,
        feeCurrency: currency,
        active: input.active,
      },
    });
    return zoneToDto(zone);
  }

  async update(businessId: string, id: string, input: z.infer<typeof UpdateZone>, currency: string) {
    const zone = await this.app.prisma.zone.findFirst({ where: { id, businessId } });
    if (!zone) throw httpErrors.createError(404, "Zone not found");
    const geometry = input.geometry ?? (input.center ? squareZoneGeometry(input.center, input.radiusKm ?? 3) : undefined);
    const updated = await this.app.prisma.zone.update({
      where: { id },
      data: {
        name: input.name,
        parish: input.parish === undefined ? undefined : input.parish || null,
        geometry: geometry as object | undefined,
        baseFee: input.baseFee != null ? minorOf(input.baseFee, currency) : undefined,
        perKmFee: input.perKmFee === undefined ? undefined : input.perKmFee == null ? null : minorOf(input.perKmFee, currency),
        urgentSurchargeFee:
          input.urgentSurchargeFee === undefined ? undefined : input.urgentSurchargeFee == null ? null : minorOf(input.urgentSurchargeFee, currency),
        active: input.active,
        version: { increment: 1 },
      },
    });
    return zoneToDto(updated);
  }

  /** zone fee for a quote: base fee + per-km rate. Scoped so a fromZoneId/toZoneId
   *  leaked or guessed from another business never prices against this one's zone. */
  async zoneFees(businessId: string, zoneId: string | null, distanceM: number | null, _currency: string) {
    if (!zoneId) return { fee: null, zone: null as ZoneDto | null };
    const zone = await this.app.prisma.zone.findFirst({ where: { id: zoneId, businessId } });
    if (!zone) return { fee: null, zone: null };
    let fee = zone.baseFee; // minor units
    if (zone.perKmFee != null && distanceM != null) {
      const perKmMajor = majorOf({ amount: zone.perKmFee, currency: zone.feeCurrency });
      fee += Math.round((distanceM / 1000) * perKmMajor * 10 ** currencyMeta(zone.feeCurrency).decimals);
    }
    return { fee, zone: zoneToDto(zone) };
  }

  async delete(businessId: string, id: string): Promise<void> {
    const zone = await this.app.prisma.zone.findFirst({ where: { id, businessId } });
    if (!zone) throw httpErrors.createError(404, "Zone not found");
    const jobCount = await this.app.prisma.job.count({ where: { zoneId: id } });
    if (jobCount > 0) {
      throw httpErrors.createError(409, `Cannot delete a zone with ${jobCount} order(s) on record — disable it instead`);
    }
    await this.app.prisma.zone.delete({ where: { id } });
  }
}

export async function zoneRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const svc = new ZonesService(ctx);
  const staff = ctx.requireStaff("admin", "dispatcher");
  // Delivery-fee zones are an owner/admin-only setting — dispatchers can read and
  // use them (for order entry, quoting) but never create/edit/enable/delete them.
  const owner = ctx.requireStaff("admin");

  app.get("/api/zones", { preHandler: staff }, async (req) => ({ zones: await svc.list(req.user!.businessId!) }));

  app.post("/api/zones", { preHandler: owner }, async (req) => {
    const body = CreateZone.parse(req.body);
    const zone = await svc.create(req.user!.businessId!, body, ctx.config.OPERATIONAL_CURRENCY);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "zone.create", "zone", zone.id, { name: zone.name });
    return { zone };
  });

  app.patch<{ Params: { id: string } }>("/api/zones/:id", { preHandler: owner }, async (req) => {
    const body = UpdateZone.parse(req.body);
    const zone = await svc.update(req.user!.businessId!, req.params.id, body, ctx.config.OPERATIONAL_CURRENCY);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "zone.update", "zone", zone.id);
    return { zone };
  });

  app.delete<{ Params: { id: string } }>("/api/zones/:id", { preHandler: owner }, async (req) => {
    await svc.delete(req.user!.businessId!, req.params.id);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "zone.delete", "zone", req.params.id);
    return { ok: true };
  });

  app.post("/api/zones/detect", { preHandler: staff }, async (req) => {
    const body = z.object({ point: z.object({ lat: z.number(), lng: z.number() }) }).parse(req.body);
    return svc.detect(req.user!.businessId!, body.point as GeoPoint);
  });

  // ---- fare rules ----
  // Not yet business-scoped in the schema (FareRule has no businessId) — out
  // of this stage's bounded scope (fare rules aren't one of the areas this
  // stage verifies isolation for). Flagged here rather than silently left
  // looking finished: a FareRule row is currently visible/editable by any
  // business's admin, referencing zone ids that ARE now business-scoped, so
  // in practice a rule naming another business's zone id just won't resolve
  // to anything (zoneFees/list scope by businessId) rather than leaking data,
  // but the fare-rules list itself is still unscoped. Revisit alongside zones
  // if fare rules become a real per-business feature.
  const CreateRule = z.object({
    fromZoneId: z.string(),
    toZoneId: z.string(),
    fee: z.number().min(0).max(1_000_000),
    minFee: z.number().min(0).max(1_000_000).optional(),
    note: z.string().max(200).optional(),
  });

  app.get("/api/zones/fare-rules", { preHandler: staff }, async (req) => {
    const rows = await ctx.prisma.fareRule.findMany({ orderBy: { validFrom: "desc" } });
    const zones = new Map((await svc.list(req.user!.businessId!)).map((z) => [z.id, z.name]));
    return {
      rules: rows.map((r) => ({
        id: r.id,
        fromZoneId: r.fromZoneId,
        fromZoneName: zones.get(r.fromZoneId) ?? r.fromZoneId,
        toZoneId: r.toZoneId,
        toZoneName: zones.get(r.toZoneId) ?? r.toZoneId,
        fee: money(r.fee, r.currency),
        minFee: r.minFee != null ? money(r.minFee, r.currency) : null,
        note: r.note,
        validFrom: r.validFrom.toISOString(),
      })),
    };
  });

  app.post("/api/zones/fare-rules", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = CreateRule.parse(req.body);
    const cur = ctx.config.OPERATIONAL_CURRENCY;
    const rule = await ctx.prisma.fareRule.upsert({
      where: { fromZoneId_toZoneId: { fromZoneId: body.fromZoneId, toZoneId: body.toZoneId } },
      create: { fromZoneId: body.fromZoneId, toZoneId: body.toZoneId, fee: minorOf(body.fee, cur), minFee: body.minFee != null ? minorOf(body.minFee, cur) : null, note: body.note, currency: cur },
      update: { fee: minorOf(body.fee, cur), minFee: body.minFee != null ? minorOf(body.minFee, cur) : null, note: body.note },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "fare_rule.upsert", "fareRule", rule.id);
    return { rule };
  });
}

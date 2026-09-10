import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { minorOf, money, majorOf, currencyMeta } from "@ronmacrae/money";
import type { GeoPoint, ZoneDto, ZoneGeometry } from "@ronmacrae/contracts";
import { pointInZone } from "@ronmacrae/geo";
import { zoneToDto } from "../geo-mappers.js";

export const GeometrySchema = z
  .object({
    type: z.enum(["Polygon", "MultiPolygon"]),
    coordinates: z.any(),
  })
  .refine((g) => Array.isArray(g.coordinates) && g.coordinates.length > 0, { message: "geometry must have coordinates" });

const CreateZone = z.object({
  name: z.string().min(1).max(80),
  parish: z.string().max(40).optional().or(z.literal("")),
  geometry: GeometrySchema,
  baseFee: z.number().min(0).max(1_000_000),
  perKmFee: z.number().min(0).max(1_000_000).optional(),
  active: z.boolean().default(true),
});

const UpdateZone = CreateZone.partial().extend({ active: z.boolean().optional() });

export class ZonesService {
  constructor(
    private readonly app: Pick<AppCtx, "prisma" | "geo" | "config">,
  ) {}

  /** Point-in-polygon over active zones. */
  async detect(point: GeoPoint | null): Promise<{ zoneId: string | null; zoneName: string | null }> {
    if (!point) return { zoneId: null, zoneName: null };
    const zones = await this.app.prisma.zone.findMany({ where: { active: true } });
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

  async list(): Promise<ZoneDto[]> {
    const rows = await this.app.prisma.zone.findMany({ orderBy: { name: "asc" } });
    return rows.map(zoneToDto);
  }

  async get(id: string) {
    const z = await this.app.prisma.zone.findUnique({ where: { id } });
    return z ? zoneToDto(z) : null;
  }

  async create(input: z.infer<typeof CreateZone>, currency: string) {
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const exists = await this.app.prisma.zone.findUnique({ where: { slug } });
    if (exists) throw httpErrors.createError(409, "Zone name already exists");
    const zone = await this.app.prisma.zone.create({
      data: {
        name: input.name,
        slug,
        parish: input.parish || null,
        geometry: input.geometry as object,
        baseFee: minorOf(input.baseFee, currency),
        perKmFee: input.perKmFee != null ? minorOf(input.perKmFee, currency) : null,
        feeCurrency: currency,
        active: input.active,
      },
    });
    return zoneToDto(zone);
  }

  async update(id: string, input: z.infer<typeof UpdateZone>, currency: string) {
    const zone = await this.app.prisma.zone.findUnique({ where: { id } });
    if (!zone) throw httpErrors.createError(404, "Zone not found");
    const updated = await this.app.prisma.zone.update({
      where: { id },
      data: {
        name: input.name,
        parish: input.parish === undefined ? undefined : input.parish || null,
        geometry: input.geometry as object | undefined,
        baseFee: input.baseFee != null ? minorOf(input.baseFee, currency) : undefined,
        perKmFee: input.perKmFee === undefined ? undefined : input.perKmFee == null ? null : minorOf(input.perKmFee, currency),
        active: input.active,
        version: { increment: 1 },
      },
    });
    return zoneToDto(updated);
  }

  /** zone fee for a quote: base fee + per-km rate */
  async zoneFees(zoneId: string | null, distanceM: number | null, _currency: string) {
    if (!zoneId) return { fee: null, zone: null as ZoneDto | null };
    const zone = await this.app.prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) return { fee: null, zone: null };
    let fee = zone.baseFee; // minor units
    if (zone.perKmFee != null && distanceM != null) {
      const perKmMajor = majorOf({ amount: zone.perKmFee, currency: zone.feeCurrency });
      fee += Math.round((distanceM / 1000) * perKmMajor * 10 ** currencyMeta(zone.feeCurrency).decimals);
    }
    return { fee, zone: zoneToDto(zone) };
  }
}

export async function zoneRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const svc = new ZonesService(ctx);
  const staff = ctx.requireStaff("admin", "dispatcher");

  app.get("/api/zones", { preHandler: staff }, async () => ({ zones: await svc.list() }));

  app.post("/api/zones", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = CreateZone.parse(req.body);
    const zone = await svc.create(body, ctx.config.OPERATIONAL_CURRENCY);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "zone.create", "zone", zone.id, { name: zone.name });
    return { zone };
  });

  app.patch<{ Params: { id: string } }>("/api/zones/:id", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = UpdateZone.parse(req.body);
    const zone = await svc.update(req.params.id, body, ctx.config.OPERATIONAL_CURRENCY);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "zone.update", "zone", zone.id);
    return { zone };
  });

  app.post("/api/zones/detect", { preHandler: staff }, async (req) => {
    const body = z.object({ point: z.object({ lat: z.number(), lng: z.number() }) }).parse(req.body);
    return svc.detect(body.point as GeoPoint);
  });

  // ---- fare rules ----
  const CreateRule = z.object({
    fromZoneId: z.string(),
    toZoneId: z.string(),
    fee: z.number().min(0).max(1_000_000),
    minFee: z.number().min(0).max(1_000_000).optional(),
    note: z.string().max(200).optional(),
  });

  app.get("/api/zones/fare-rules", { preHandler: staff }, async () => {
    const rows = await ctx.prisma.fareRule.findMany({ orderBy: { validFrom: "desc" } });
    const zones = new Map((await svc.list()).map((z) => [z.id, z.name]));
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

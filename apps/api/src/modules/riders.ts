import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { normalizePhone } from "./auth.js";
import { pointFromJson, pointToJson, moneyField } from "../geo-mappers.js";
import { minorOf } from "@ronmacrae/money";
import { hashPassword } from "../lib/password.js";
import { ACTIVE_JOB_STATUSES, type GeoPoint, type RiderDto, type RiderLocationDto, type RiderStatus, type VehicleType } from "@ronmacrae/contracts";
import { Prisma, type Rider } from "@prisma/client";

/** Re-exported for backward compatibility; canonical set lives in contracts. */
export { ACTIVE_JOB_STATUSES };

type RiderWithZone = Rider & { homeZone: { name: string } | null };

export function riderToDto(
  r: RiderWithZone,
  extra?: { currentJobId?: string | null },
): RiderDto {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    vehicle: r.vehicle,
    plate: r.plate,
    photoUrl: r.photoUrl,
    status: r.status,
    homeZoneId: r.homeZoneId,
    homeZoneName: r.homeZone?.name ?? null,
    basePoint: pointFromJson(r.basePoint),
    dailyCapacity: r.dailyCapacity,
    payRatePerDelivery: moneyField(r.payRate, r.payCurrency),
    active: r.active,
    currentJobId: extra?.currentJobId ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function currentJobIdFor(
  app: AppCtx,
  riderId: string,
): Promise<string | null> {
  const job = await app.prisma.job.findFirst({
    where: { riderId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  return job?.id ?? null;
}

async function withCurrentJob(app: AppCtx, rider: RiderWithZone): Promise<RiderDto> {
  return riderToDto(rider, { currentJobId: await currentJobIdFor(app, rider.id) });
}

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(7).max(20),
  vehicle: z.enum(["motorcycle", "car"]).default("motorcycle"),
  plate: z.string().max(20).optional().or(z.literal("")).nullable().default(""),
  homeZoneId: z.string().optional().or(z.literal("")).nullable().default(""),
  basePoint: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }).optional().nullable(),
  dailyCapacity: z.number().int().min(1).max(100).default(15),
  payRate: z.number().min(0).max(1_000_000).optional(),
  /** optional login account for the rider (bearer face) */
  password: z.string().min(8).max(128).optional(),
});

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  phone: z.string().min(7).max(20).optional(),
  vehicle: z.enum(["motorcycle", "car"]).optional(),
  plate: z.string().max(20).optional().or(z.literal("")).nullable(),
  homeZoneId: z.string().optional().or(z.literal("")).nullable(),
  basePoint: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }).optional().nullable(),
  dailyCapacity: z.number().int().min(1).max(100).optional(),
  payRate: z.number().min(0).max(1_000_000).optional().nullable(),
  active: z.boolean().optional(),
  status: z.enum(["offline", "available", "on_job", "unavailable"]).optional(),
});

const StatusBody = z.object({
  status: z.enum(["offline", "available", "on_job", "unavailable"]),
  reason: z.string().max(120).optional(),
});

const ListQuery = z.object({
  includeInactive: z.coerce.boolean().default(false),
});

export class RidersService {
  constructor(private readonly app: AppCtx) {}

  async list(includeInactive: boolean): Promise<RiderDto[]> {
    const rows = await this.app.prisma.rider.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: { name: "asc" },
      include: { homeZone: { select: { name: true } } },
    });
    const ids = rows.map((r) => r.id);
    const jobs = await this.app.prisma.job.findMany({
      where: { riderId: { in: ids }, status: { in: [...ACTIVE_JOB_STATUSES] } },
      orderBy: { updatedAt: "desc" },
      select: { riderId: true, id: true },
    });
    const current = new Map<string, string>();
    for (const j of jobs) {
      if (!j.riderId) continue;
      if (!current.has(j.riderId)) current.set(j.riderId, j.id);
    }
    return rows.map((r) => riderToDto(r, { currentJobId: current.get(r.id) ?? null }));
  }

  async get(id: string): Promise<RiderDto | null> {
    const row = await this.app.prisma.rider.findUnique({
      where: { id },
      include: { homeZone: { select: { name: true } } },
    });
    if (!row) return null;
    return withCurrentJob(this.app, row);
  }

  async create(input: z.infer<typeof CreateBody>, currency: string): Promise<RiderDto> {
    const phone = normalizePhone(input.phone);
    const exists = await this.app.prisma.rider.findUnique({ where: { phone } });
    if (exists) throw httpErrors.createError(409, "A rider with this phone number already exists");
    let userId: string | null = null;
    if (input.password) {
      const user = await this.app.prisma.user.upsert({
        where: { phone },
        create: { phone, name: input.name, role: "rider", passwordHash: hashPassword(input.password) },
        update: { name: input.name },
      });
      userId = user.id;
    }
    const row = await this.app.prisma.rider.create({
      data: {
        userId,
        name: input.name,
        phone,
        vehicle: input.vehicle as VehicleType,
        plate: input.plate || null,
        homeZoneId: input.homeZoneId || null,
        basePoint: pointToJson(input.basePoint ?? null) ?? Prisma.JsonNull,
        dailyCapacity: input.dailyCapacity,
        payRate: input.payRate != null ? minorOf(input.payRate, currency) : null,
        status: "available",
      },
      include: { homeZone: { select: { name: true } } },
    });
    return withCurrentJob(this.app, row);
  }

  async update(id: string, input: z.infer<typeof UpdateBody>, currency: string): Promise<RiderDto> {
    const row = await this.app.prisma.rider.findUnique({ where: { id } });
    if (!row) throw httpErrors.createError(404, "Rider not found");
    const updated = await this.app.prisma.rider.update({
      where: { id },
      data: {
        name: input.name,
        phone: input.phone ? normalizePhone(input.phone) : undefined,
        vehicle: input.vehicle,
        plate: input.plate === undefined ? undefined : input.plate || null,
        homeZoneId: input.homeZoneId === undefined ? undefined : input.homeZoneId || null,
        basePoint: input.basePoint === undefined ? undefined : (pointToJson(input.basePoint ?? null) ?? Prisma.JsonNull),
        dailyCapacity: input.dailyCapacity,
        payRate: input.payRate === undefined ? undefined : input.payRate == null ? null : minorOf(input.payRate, currency),
        active: input.active,
        status: input.status,
      },
      include: { homeZone: { select: { name: true } } },
    });
    if (input.active === false && updated.userId) {
      await this.app.prisma.session.deleteMany({ where: { userId: updated.userId } });
    }
    return withCurrentJob(this.app, updated);
  }

  /**
   * Status change. Riders may toggle their own status (available/offline);
   * staff may set any status on any rider.
   */
  async setStatus(
    riderId: string,
    body: z.infer<typeof StatusBody>,
    actor: { id: string; role: string; riderId?: string },
  ): Promise<RiderDto> {
    const row = await this.app.prisma.rider.findUnique({
      where: { id: riderId },
      include: { homeZone: { select: { name: true } } },
    });
    if (!row) throw httpErrors.createError(404, "Rider not found");
    if (actor.role === "rider" && actor.riderId !== riderId) {
      throw httpErrors.createError(403, "You can only change your own status");
    }
    if (row.status === "on_job" && body.status === "offline") {
      const active = await this.app.prisma.job.count({ where: { riderId, status: { in: [...ACTIVE_JOB_STATUSES] } } });
      if (active > 0) throw httpErrors.createError(409, `Cannot go offline with ${active} active job(s)`);
    }
    const updated = await this.app.prisma.rider.update({
      where: { id: riderId },
      data: { status: body.status as RiderStatus },
    });
    await this.app.hub.broadcast(
      `rider:${riderId}`,
      { type: "rider.status", payload: { riderId, status: body.status } },
    );
    this.app.hub.broadcast("dispatch", { type: "rider.status", payload: { riderId, status: body.status, name: row.name } });
    await this.app.audit.record(actor, "rider.status", "rider", riderId, { status: body.status, reason: body.reason ?? null });
    return withCurrentJob(this.app, { ...updated, homeZone: row.homeZone });
  }

  /**
   * Location report from the bearer client (real GPS when granted; the
   * simulator feeds the same pipeline until then). Broadcasts to the rider
   * room, the job room and dispatch.
   */
  async reportLocation(
    riderId: string,
    input: { point: GeoPoint; trackingState?: "active" | "degraded" | "paused" | "unavailable"; clientSeq?: number },
  ): Promise<void> {
    const row = await this.app.prisma.rider.findFirst({ where: { id: riderId }, select: { id: true } });
    if (!row) throw httpErrors.createError(404, "Rider not found");
    const last = await this.app.prisma.riderLocation.findFirst({
      where: { riderId },
      orderBy: { clientSeq: "desc" },
      select: { clientSeq: true },
    });
    const clientSeq = input.clientSeq ?? (last?.clientSeq ?? 0) + 1;
    await this.app.prisma.riderLocation.create({
      data: {
        riderId,
        point: pointToJson(input.point) as Prisma.InputJsonValue,
        heading: null,
        speedKph: null,
        battery: null,
        trackingState: input.trackingState ?? "active",
        clientSeq,
      },
    });
    const job = await this.app.prisma.job.findFirst({
      where: { riderId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      select: { id: true },
    });
    // A real report (this method) always wins over the preview-only simulated leg
    // for the rider's active job — matches LocationSimulator's own documented intent
    // ("the web bearer app can override the simulation with real GPS"), which the
    // simulator's write path alone can't enforce since it never sees real reports.
    if (job) this.app.sim.stopForJob(job.id);
    const dto = {
      id: `loc-${clientSeq}`,
      riderId,
      point: input.point,
      heading: null,
      speedKph: null,
      batteryPct: null,
      trackingState: input.trackingState ?? "active",
      at: new Date().toISOString(),
    };
    const rooms = [`rider:${riderId}`, "dispatch"];
    if (job) rooms.push(`job:${job.id}`);
    this.app.hub.broadcastMany(rooms, { type: "rider.location", payload: dto });
  }

  /**
   * Latest known point per active rider, for the dispatcher map's initial render
   * (realtime `rider.location` messages carry live updates after that). Bounded to
   * the last 24h so a location scan never has to walk the full, ever-growing
   * history table.
   */
  async latestLocations(): Promise<RiderLocationDto[]> {
    const riders = await this.app.prisma.rider.findMany({ where: { active: true }, select: { id: true } });
    const riderIds = riders.map((r) => r.id);
    if (riderIds.length === 0) return [];
    const rows = await this.app.prisma.riderLocation.findMany({
      where: { riderId: { in: riderIds }, at: { gte: new Date(Date.now() - 24 * 3600_000) } },
      orderBy: { at: "desc" },
    });
    const latestByRider = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latestByRider.has(row.riderId)) latestByRider.set(row.riderId, row);
    return [...latestByRider.values()].map((row) => ({
      id: row.id,
      riderId: row.riderId,
      point: pointFromJson(row.point)!,
      heading: row.heading,
      speedKph: row.speedKph,
      batteryPct: row.battery,
      trackingState: row.trackingState as RiderLocationDto["trackingState"],
      at: row.at.toISOString(),
    }));
  }
}

export async function riderRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const svc = new RidersService(ctx);

  app.get("/api/riders", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    const q = ListQuery.parse(req.query);
    return { riders: await svc.list(q.includeInactive) };
  });

  app.post("/api/riders", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = CreateBody.parse(req.body);
    const rider = await svc.create(body, ctx.config.OPERATIONAL_CURRENCY);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "rider.create", "rider", rider.id, { name: rider.name });
    return { rider };
  });

  app.get<{ Params: { id: string } }>("/api/riders/:id", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    const rider = await svc.get(req.params.id);
    if (!rider) throw httpErrors.createError(404, "Rider not found");
    return { rider };
  });

  app.patch<{ Params: { id: string } }>("/api/riders/:id", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = UpdateBody.parse(req.body);
    const rider = await svc.update(req.params.id, body, ctx.config.OPERATIONAL_CURRENCY);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "rider.update", "rider", rider.id);
    return { rider };
  });

  app.patch<{ Params: { id: string } }>("/api/riders/:id/status", { preHandler: ctx.requireAuth }, async (req) => {
    const body = StatusBody.parse(req.body);
    const rider = await svc.setStatus(req.params.id, body, {
      id: req.user!.sub,
      role: req.user!.role,
      riderId: req.user!.riderId,
    });
    return { rider };
  });

  app.get("/api/rider-locations", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async () => {
    return { locations: await svc.latestLocations() };
  });

  app.post<{ Params: { id: string } }>("/api/rider-locations/:id/report", { preHandler: ctx.requireAuth }, async (req) => {
    const body = z
      .object({
        point: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }),
        trackingState: z.enum(["active", "degraded", "paused", "unavailable"]).optional(),
        clientSeq: z.number().int().min(1).max(1_000_000).optional(),
      })
      .parse(req.body);
    const riderId = req.user!.role === "rider" ? (req.user!.riderId ?? req.params.id) : req.params.id;
    if (req.user!.role === "rider" && riderId !== req.user!.riderId) {
      throw httpErrors.createError(403, "You can only report your own location");
    }
    if (req.user!.role !== "rider" && !["admin", "dispatcher"].includes(req.user!.role)) {
      throw httpErrors.createError(403, "Insufficient permissions");
    }
    await svc.reportLocation(riderId, body);
    return { ok: true };
  });
}

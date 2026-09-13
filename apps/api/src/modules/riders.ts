import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { normalizePhone } from "./auth.js";
import { DEFAULT_PUBLIC_BUSINESS_SLUG } from "./order.js";
import { sendEmailCode, consumeEmailCode } from "./customer-account.js";

const RIDER_EMAIL_VERIFY_PURPOSE = "verify_rider_email";
import { pointFromJson, pointToJson, moneyField } from "../geo-mappers.js";
import { minorOf } from "@ronmacrae/money";
import { hashPassword } from "../lib/password.js";
import { ACTIVE_JOB_STATUSES, roomForDispatch, type GeoPoint, type RiderDto, type RiderLocationDto, type RiderStatus, type VehicleType } from "@ronmacrae/contracts";
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
  /** Max concurrent active jobs this rider can carry at once (not a daily total,
   *  despite the field's name — see the schema comment on Rider.dailyCapacity).
   *  Owner/admin-configurable per rider; a rider is not limited to one job at a time. */
  dailyCapacity: z.number().int().min(1).max(100).default(5),
  payRate: z.number().min(0).max(1_000_000).optional(),
  /** optional login account for the rider (bearer face) — email is the
   *  login credential going forward (see SignupBody's own doc comment);
   *  phone stays the identity/matching key regardless. */
  email: z.string().email().max(160).optional().or(z.literal("")).nullable(),
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

/** Public self-signup — deliberately smaller than CreateBody (a staff
 *  member fills in operational details like homeZone/payRate/dailyCapacity
 *  later; an applicant just needs to identify themselves and set a
 *  password to log in once approved). */
const SignupBody = z.object({
  name: z.string().min(1).max(120),
  /** The identity/matching + coordination key (messages, WhatsApp) — not
   *  the login credential. See `email` below for that. */
  phone: z.string().min(7).max(20),
  /** The login credential going forward — phone stays how the system
   *  recognizes/links a person across roles (rider, customer), but
   *  signing in is by email + password, no OTP. */
  email: z.string().email().max(160),
  vehicle: z.enum(["motorcycle", "car"]).default("motorcycle"),
  plate: z.string().max(20).optional().or(z.literal("")).nullable().default(""),
  password: z.string().min(8).max(128),
});

const ApproveBody = z.object({
  approve: z.boolean(),
});

const VerifyBody = z.object({
  email: z.string().email().max(160),
  code: z.string().min(4).max(10),
});

const ResendBody = z.object({
  email: z.string().email().max(160),
});

export class RidersService {
  constructor(private readonly app: AppCtx) {}

  /** Riders who are members of this business — global riders shared with
   *  other businesses never appear in a business that hasn't invited them. */
  async list(businessId: string, includeInactive: boolean): Promise<RiderDto[]> {
    const rows = await this.app.prisma.rider.findMany({
      where: {
        ...(includeInactive ? {} : { active: true }),
        memberships: { some: { businessId, ...(includeInactive ? {} : { status: "active" }) } },
      },
      orderBy: { name: "asc" },
      include: { homeZone: { select: { name: true } } },
    });
    const ids = rows.map((r) => r.id);
    // Deliberately global (not businessId-scoped) — see the same note in
    // ops-board.ts: a rider's "current job" for capacity/status purposes
    // reflects their real total load, not just this business's slice.
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

  async get(businessId: string, id: string): Promise<RiderDto | null> {
    const row = await this.app.prisma.rider.findFirst({
      where: { id, memberships: { some: { businessId } } },
      include: { homeZone: { select: { name: true } } },
    });
    if (!row) return null;
    return withCurrentJob(this.app, row);
  }

  /**
   * Add a rider to this business. If the phone matches an existing *global*
   * rider (shared with another business, or previously removed from this
   * one), this reuses that identity and just adds/reactivates the
   * membership here — it never creates a second Rider row for the same
   * person, and never lets one business silently overwrite another's
   * existing profile fields for that shared rider. A genuinely new rider
   * starts platform-`pending` — the platform owner still has to approve
   * them for the open network before their membership here can go active.
   */
  async create(businessId: string, input: z.infer<typeof CreateBody>, currency: string): Promise<RiderDto> {
    const phone = normalizePhone(input.phone);
    const existing = await this.app.prisma.rider.findUnique({ where: { phone } });
    if (existing) {
      const existingMembership = await this.app.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId: existing.id, businessId } } });
      if (existingMembership?.status === "active") throw httpErrors.createError(409, "A rider with this phone number is already a member of your business");
      const membershipStatus = existing.platformStatus === "approved" ? "active" : "pending";
      if (existingMembership) {
        await this.app.prisma.riderMembership.update({ where: { id: existingMembership.id }, data: { status: membershipStatus, approvedAt: membershipStatus === "active" ? new Date() : null } });
      } else {
        await this.app.prisma.riderMembership.create({ data: { riderId: existing.id, businessId, status: membershipStatus, approvedAt: membershipStatus === "active" ? new Date() : null } });
      }
      const row = await this.app.prisma.rider.findUniqueOrThrow({ where: { id: existing.id }, include: { homeZone: { select: { name: true } } } });
      return withCurrentJob(this.app, row);
    }
    let userId: string | null = null;
    if (input.password) {
      const email = input.email || null;
      if (email) {
        const emailOwner = await this.app.prisma.user.findUnique({ where: { email } });
        if (emailOwner && emailOwner.phone !== phone) {
          throw httpErrors.createError(409, "This email is already associated with a different account");
        }
      }
      // An admin/dispatcher setting this email is itself the vouching — no
      // code-verification step, unlike the public self-signup path below.
      const user = await this.app.prisma.user.upsert({
        where: { phone },
        create: { phone, email, emailVerifiedAt: email ? new Date() : null, name: input.name, role: "rider", passwordHash: hashPassword(input.password) },
        update: { name: input.name, ...(email ? { email, emailVerifiedAt: new Date() } : {}) },
      });
      userId = user.id;
    }
    // Deliberately not wrapped in a $transaction with the membership
    // create below — same reasoning as selfSignup()'s own comment: an
    // upsert here is idempotent (safe to re-enter if the process dies
    // between the two calls) and avoids relying on write visibility
    // between the two statements, which the test harness's own
    // rider.create() hook (a second, independent membership insert) isn't
    // guaranteed to see consistently from inside an open transaction.
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
        // Platform approval gates a rider being *shared* onto a second
        // business later (see the `existing` branch above) — it does not
        // block the one business that's directly onboarding them right
        // now, who is themselves vouching for this rider by adding them.
        platformStatus: "pending",
      },
      include: { homeZone: { select: { name: true } } },
    });
    await this.app.prisma.riderMembership.upsert({
      where: { riderId_businessId: { riderId: row.id, businessId } },
      create: { riderId: row.id, businessId, status: "active", approvedAt: new Date() },
      update: { status: "active", approvedAt: new Date() },
    });
    return withCurrentJob(this.app, row);
  }

  /**
   * Public, unauthenticated rider application (spec: "no way for a rider
   * to sign up which it should"). Unlike `create()` above — where a staff
   * member is directly vouching for the rider they're adding, so the
   * membership goes active immediately — nobody vouches for a self-signup,
   * so the membership always starts `pending` for a genuinely new rider,
   * regardless of platform status. An existing, already
   * platform-`approved` rider (vetted at another business already) is the
   * one exception: their membership here can go straight to active, same
   * rule `create()` already uses for a re-adding staff member.
   */
  async selfSignup(businessId: string, input: z.infer<typeof SignupBody>): Promise<{ status: "pending" | "active"; riderId: string }> {
    const phone = normalizePhone(input.phone);
    const existing = await this.app.prisma.rider.findUnique({ where: { phone } });
    if (existing) {
      const existingMembership = await this.app.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId: existing.id, businessId } } });
      if (existingMembership?.status === "active") throw httpErrors.createError(409, "This phone number is already an active rider with us");
      const status = existing.platformStatus === "approved" ? "active" : "pending";
      if (existingMembership) {
        await this.app.prisma.riderMembership.update({ where: { id: existingMembership.id }, data: { status, approvedAt: status === "active" ? new Date() : null } });
      } else {
        await this.app.prisma.riderMembership.create({ data: { riderId: existing.id, businessId, status, approvedAt: status === "active" ? new Date() : null } });
      }
      return { status, riderId: existing.id };
    }

    const emailOwner = await this.app.prisma.user.findUnique({ where: { email: input.email } });
    if (emailOwner && emailOwner.phone !== phone) {
      throw httpErrors.createError(409, "This email is already associated with a different account");
    }
    const user = await this.app.prisma.user.upsert({
      where: { phone },
      create: { phone, email: input.email, name: input.name, role: "rider", passwordHash: hashPassword(input.password) },
      update: { name: input.name, email: input.email },
    });
    const rider = await this.app.prisma.rider.create({
      data: {
        userId: user.id,
        name: input.name,
        phone,
        vehicle: input.vehicle as VehicleType,
        plate: input.plate || null,
        dailyCapacity: 5,
        status: "available",
        platformStatus: "pending",
      },
    });
    // Deliberately not wrapped in a transaction with the rider.create above:
    // a self-signup's membership must always end up `pending` regardless of
    // whatever default a rider-creation hook elsewhere might apply, so this
    // is an idempotent upsert rather than an insert that could conflict
    // with one. If the process dies between the two calls, re-submitting
    // the same phone number safely re-enters this same upsert.
    await this.app.prisma.riderMembership.upsert({
      where: { riderId_businessId: { riderId: rider.id, businessId } },
      create: { riderId: rider.id, businessId, status: "pending" },
      update: { status: "pending" },
    });
    await sendEmailCode(this.app, input.email, RIDER_EMAIL_VERIFY_PURPOSE, "Verify your email", (code) => `Your Ronmacrae rider sign-up code is ${code}. It expires in 10 minutes.`);
    return { status: "pending", riderId: rider.id };
  }

  /** Resend the verification code — same cooldown as sendEmailCode's own
   *  guard, so this is safe to expose without extra rate-limiting logic
   *  here specifically. */
  async resendVerification(email: string): Promise<void> {
    await sendEmailCode(this.app, email, RIDER_EMAIL_VERIFY_PURPOSE, "Verify your email", (code) => `Your Ronmacrae rider sign-up code is ${code}. It expires in 10 minutes.`);
  }

  /** Proves ownership of the email given at signup — required before this
   *  rider's account can log in (see auth.ts's login route). Does not by
   *  itself approve the membership; that's still a separate admin
   *  decision (decideMembership above). */
  async verifyEmail(email: string, code: string): Promise<void> {
    await consumeEmailCode(this.app, email, RIDER_EMAIL_VERIFY_PURPOSE, code);
    await this.app.prisma.user.updateMany({ where: { email, role: "rider" }, data: { emailVerifiedAt: new Date() } });
  }

  /** Pending applications waiting on this business's own approval — not
   *  the platform-wide `platformStatus` gate, which is a separate,
   *  owner-console concern (see schema's PlatformRiderStatus doc comment). */
  async listPending(businessId: string): Promise<RiderDto[]> {
    const rows = await this.app.prisma.rider.findMany({
      where: { memberships: { some: { businessId, status: "pending" } } },
      include: { homeZone: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(rows.map((r) => withCurrentJob(this.app, r)));
  }

  /** Approves or rejects one pending application at this business. Rejecting
   *  sets the membership to `removed`, not deleted — same "corrections are
   *  new state, not erased history" discipline as everywhere else in this
   *  app (audit trail stays intact either way). */
  async decideMembership(businessId: string, riderId: string, approve: boolean): Promise<void> {
    const membership = await this.app.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId, businessId } } });
    if (!membership || membership.status !== "pending") throw httpErrors.createError(404, "No pending application found for this rider");
    await this.app.prisma.riderMembership.update({
      where: { id: membership.id },
      data: approve ? { status: "active", approvedAt: new Date() } : { status: "removed" },
    });
  }

  async update(businessId: string, id: string, input: z.infer<typeof UpdateBody>, currency: string): Promise<RiderDto> {
    const row = await this.app.prisma.rider.findFirst({ where: { id, memberships: { some: { businessId } } } });
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
   * Status change. Riders may toggle their own status ("Available for jobs" /
   * "Unavailable"); staff may set any status on any rider. Going fully
   * "offline" while carrying active jobs is blocked regardless of the rider's
   * current status value — "unavailable" (stop sending me new work, but I'm
   * still finishing what I have) is always allowed with active jobs; going
   * fully offline is not, since that's meant to mean off-shift/unreachable.
   */
  async setStatus(
    riderId: string,
    body: z.infer<typeof StatusBody>,
    actor: { id: string; role: string; riderId?: string; businessId?: string | null },
  ): Promise<RiderDto> {
    const row = await this.app.prisma.rider.findUnique({
      where: { id: riderId },
      include: { homeZone: { select: { name: true } } },
    });
    if (!row) throw httpErrors.createError(404, "Rider not found");
    if (actor.role === "rider" && actor.riderId !== riderId) {
      throw httpErrors.createError(403, "You can only change your own status");
    }
    if (actor.role !== "rider") {
      // Staff may only change the status of a rider actually in their own
      // network — not some other business's rider, even one this rider
      // happens to also carry jobs for.
      const membership = await this.app.prisma.riderMembership.findUnique({ where: { riderId_businessId: { riderId, businessId: actor.businessId ?? "__none__" } } });
      if (membership?.status !== "active") throw httpErrors.createError(404, "Rider not found");
    }
    if (body.status === "offline") {
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
    // Every business this rider is actively a member of cares about their
    // availability changing — never just the business that happened to
    // trigger this particular call.
    const memberships = await this.app.prisma.riderMembership.findMany({ where: { riderId, status: "active" }, select: { businessId: true } });
    for (const m of memberships) {
      this.app.hub.broadcast(roomForDispatch(m.businessId), { type: "rider.status", payload: { riderId, status: body.status, name: row.name } });
    }
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
    const jobsForRider = await this.app.prisma.job.findMany({
      where: { riderId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      select: { id: true, businessId: true },
    });
    // A real report (this method) always wins over the preview-only simulated leg
    // for the rider's active job — matches LocationSimulator's own documented intent
    // ("the web bearer app can override the simulation with real GPS"), which the
    // simulator's write path alone can't enforce since it never sees real reports.
    for (const j of jobsForRider) this.app.sim.stopForJob(j.id);
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
    // Live position goes out to every job room this rider currently has
    // active, plus — matching the ops board / rider-locations REST snapshot
    // — every business that has an active membership with this rider, not
    // only ones with a job in flight right now (a dispatcher watches their
    // available riders' positions too, before assigning anything).
    const memberships = await this.app.prisma.riderMembership.findMany({ where: { riderId, status: "active" }, select: { businessId: true } });
    const rooms = [
      `rider:${riderId}`,
      ...jobsForRider.map((j) => `job:${j.id}`),
      ...memberships.map((m) => roomForDispatch(m.businessId)),
    ];
    this.app.hub.broadcastMany(rooms, { type: "rider.location", payload: dto });
  }

  /**
   * Latest known point per active rider, for the dispatcher map's initial render
   * (realtime `rider.location` messages carry live updates after that). Bounded to
   * the last 24h so a location scan never has to walk the full, ever-growing
   * history table.
   */
  async latestLocations(businessId: string): Promise<RiderLocationDto[]> {
    // Same roster rule as list()/the ops board: any rider who is an active
    // member of this business — a dispatcher legitimately wants to see
    // where their own available riders are before assigning anything, not
    // only once a job is already underway. A rider never a member of this
    // business (or removed from it) is never visible here, which is the
    // real isolation boundary: never another business's location data for a
    // rider who isn't even part of this one's network.
    const riders = await this.app.prisma.rider.findMany({
      where: { active: true, memberships: { some: { businessId, status: "active" } } },
      select: { id: true },
    });
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
    return { riders: await svc.list(req.user!.businessId!, q.includeInactive) };
  });

  app.post("/api/riders", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = CreateBody.parse(req.body);
    const rider = await svc.create(req.user!.businessId!, body, ctx.config.OPERATIONAL_CURRENCY);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "rider.create", "rider", rider.id, { name: rider.name });
    return { rider };
  });

  app.get<{ Params: { id: string } }>("/api/riders/:id", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    const rider = await svc.get(req.user!.businessId!, req.params.id);
    if (!rider) throw httpErrors.createError(404, "Rider not found");
    return { rider };
  });

  // Public — no login required, matches order.ts's own public routes.
  app.post(
    "/api/rider-signup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const body = SignupBody.parse(req.body);
      const business = await ctx.prisma.business.findUnique({ where: { slug: DEFAULT_PUBLIC_BUSINESS_SLUG } });
      if (!business) throw httpErrors.createError(503, "Rider sign-up is not available right now");
      const result = await svc.selfSignup(business.id, body);
      await ctx.audit.record({ id: null, role: "anonymous" }, "rider.signup", "rider", result.riderId, { status: result.status });
      return result;
    },
  );

  app.post(
    "/api/rider-signup/verify",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const body = VerifyBody.parse(req.body);
      await svc.verifyEmail(body.email, body.code);
      return { ok: true };
    },
  );

  app.post(
    "/api/rider-signup/resend",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const body = ResendBody.parse(req.body);
      await svc.resendVerification(body.email);
      return { ok: true };
    },
  );

  app.get("/api/riders/pending", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    return { riders: await svc.listPending(req.user!.businessId!) };
  });

  app.post<{ Params: { id: string } }>("/api/riders/:id/decide", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = ApproveBody.parse(req.body);
    await svc.decideMembership(req.user!.businessId!, req.params.id, body.approve);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, body.approve ? "rider.approve" : "rider.reject", "rider", req.params.id);
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/riders/:id", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = UpdateBody.parse(req.body);
    const rider = await svc.update(req.user!.businessId!, req.params.id, body, ctx.config.OPERATIONAL_CURRENCY);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "rider.update", "rider", rider.id);
    return { rider };
  });

  app.patch<{ Params: { id: string } }>("/api/riders/:id/status", { preHandler: ctx.requireAuth }, async (req) => {
    const body = StatusBody.parse(req.body);
    const rider = await svc.setStatus(req.params.id, body, {
      id: req.user!.sub,
      role: req.user!.role,
      riderId: req.user!.riderId,
      businessId: req.user!.businessId,
    });
    return { rider };
  });

  app.get("/api/rider-locations", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    return { locations: await svc.latestLocations(req.user!.businessId!) };
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

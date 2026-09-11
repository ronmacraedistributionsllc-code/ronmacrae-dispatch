import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import type { CustomerPackageDto, CustomerPackagesDto, JobStatus, TrackingState } from "@ronmacrae/contracts";
import { toCustomerStatus } from "@ronmacrae/contracts";
import { normalizePhone } from "../lib/phone.js";
import { pointFromJson, moneyField } from "../geo-mappers.js";
import { PIN_VISIBLE_STATUSES, LOCATION_VISIBLE_STATUSES } from "./tracking.js";
import { CUSTOMER_DASHBOARD_TTL_S } from "../lib/jwt.js";
import { verifyCustomerIdentity, findIdentityId } from "./customer-identity.js";
import { CODE_TTL_MS, REQUEST_COOLDOWN_MS, MAX_VERIFY_ATTEMPTS, hashVerificationCode, generateVerificationCode } from "../lib/verification-code.js";

const TERMINAL_CUSTOMER_STATUSES = new Set(["delivered", "failed", "returned", "cancelled"]);

const hashCode = hashVerificationCode;
const generateCode = generateVerificationCode;

const RequestCodeBody = z.object({ phone: z.string().min(4).max(30) });
const VerifyBody = z.object({ phone: z.string().min(4).max(30), code: z.string().min(4).max(10) });

/**
 * Cross-business customer package dashboard (spec 4). Public, no staff/rider
 * login — phone-ownership verified by a short-lived, single-use code (like
 * an OTP), never a password or a persistent account. See lib/jwt.ts's
 * CustomerDashboardTokenPayload and lib/phone.ts's normalizePhone for the
 * two pieces this leans on. As of Stage 23, a successful verify() here is
 * also the one and only way a CustomerIdentity ever becomes "verified"
 * (see customer-identity.ts) — Stage 22's write-up in WORK_IN_PROGRESS.md
 * has the fuller original reasoning, including the two real bugs found
 * while building it (the notification-outbox cross-business leak, and the
 * unrestricted rider-location display).
 *
 * IMPORTANT, honestly: actual SMS delivery (a real provider, not the dev
 * memory provider) and a real customer completing this flow with a code
 * that genuinely arrived on their own phone have NOT been tested on real
 * hardware in this session — only the dev/e2e path (memory provider, code
 * read back via Prisma) is verified. Do not represent this as
 * device-tested until it has been.
 */
export async function customerDashboardRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post("/api/customer-dashboard/request-code", async (req) => {
    const body = RequestCodeBody.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw httpErrors.createError(400, "Enter a valid phone number.");

    const recent = await ctx.prisma.customerAccessCode.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    });
    if (recent && Date.now() - recent.createdAt.getTime() < REQUEST_COOLDOWN_MS) {
      throw httpErrors.createError(429, "Please wait a moment before requesting another code.");
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await ctx.prisma.customerAccessCode.create({
      data: { phone, codeHash: hashCode(phone, code), expiresAt },
    });
    // No businessId: this code isn't from any one business, and must never
    // show up in any business's staff notification list (see notify.ts).
    // `phone` is already the real E.164 form (lib/phone.ts) — no separate
    // "to"-address formatting needed.
    await ctx.notify.enqueue({
      channel: "sms",
      to: phone,
      template: "customer_dashboard_code",
      params: { code },
    });
    return { ok: true };
  });

  app.post("/api/customer-dashboard/verify", async (req) => {
    const body = VerifyBody.parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw httpErrors.createError(400, "Enter a valid phone number.");

    const row = await ctx.prisma.customerAccessCode.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw httpErrors.createError(400, "That code has expired or wasn't found — request a new one.");
    if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
      await ctx.prisma.customerAccessCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
      throw httpErrors.createError(400, "Too many attempts — request a new code.");
    }
    if (row.codeHash !== hashCode(phone, body.code.trim())) {
      await ctx.prisma.customerAccessCode.update({ where: { id: row.id }, data: { attempts: row.attempts + 1 } });
      throw httpErrors.createError(400, "Incorrect code.");
    }
    await ctx.prisma.customerAccessCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    // Proof of ownership — the one and only trigger that ever marks a
    // CustomerIdentity "verified" (best-effort: a failure here must never
    // block the customer from getting into their own dashboard).
    await verifyCustomerIdentity(ctx, phone).catch((err: unknown) =>
      ctx.log.error({ err: String(err) }, "customer identity verification failed"),
    );
    const token = await ctx.jwt.issueCustomerDashboard(phone);
    return { token, expiresInSeconds: CUSTOMER_DASHBOARD_TTL_S };
  });

  app.get("/api/customer-dashboard", async (req) => {
    const phone = await requireCustomerDashboardPhone(ctx, req);
    return buildDashboard(ctx, phone);
  });
}

async function requireCustomerDashboardPhone(ctx: AppCtx, req: FastifyRequest): Promise<string> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw httpErrors.createError(401, "Enter your phone number to see your packages.");
  const payload = await ctx.jwt.verifyCustomerDashboard(token);
  if (!payload) throw httpErrors.createError(401, "Your session has expired — enter your phone number again.");
  return payload.phone;
}

/**
 * Finds every business's Customer row linked to this phone's
 * CustomerIdentity (Stage 23) and aggregates their jobs. A genuine indexed
 * lookup, not a scan — and it follows a merge alias too (see
 * customer-identity.ts's findIdentityId), so a customer whose duplicate
 * identity the platform owner has since merged still sees everything under
 * whichever phone they actually type in.
 */
async function buildDashboard(ctx: AppCtx, phone: string): Promise<CustomerPackagesDto> {
  const identityId = await findIdentityId(ctx, phone);
  if (!identityId) {
    return { active: [], history: [], generatedAt: new Date().toISOString() };
  }
  const customers = await ctx.prisma.customer.findMany({ where: { identityId }, select: { id: true } });
  const customerIds = customers.map((c) => c.id);
  if (customerIds.length === 0) {
    return { active: [], history: [], generatedAt: new Date().toISOString() };
  }

  const jobs = await ctx.prisma.job.findMany({
    where: { customerId: { in: customerIds } },
    orderBy: { createdAt: "desc" },
  });
  if (jobs.length === 0) {
    return { active: [], history: [], generatedAt: new Date().toISOString() };
  }

  const businessIds = [...new Set(jobs.map((j) => j.businessId))];
  const riderIds = [...new Set(jobs.map((j) => j.riderId).filter((id): id is string => Boolean(id)))];
  const jobIds = jobs.map((j) => j.id);

  const [businesses, riders, links] = await Promise.all([
    ctx.prisma.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true } }),
    riderIds.length
      ? ctx.prisma.rider.findMany({ where: { id: { in: riderIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    ctx.prisma.trackingLink.findMany({
      where: { jobId: { in: jobIds }, revoked: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const businessNameById = new Map(businesses.map((b) => [b.id, b.name]));
  const riderNameById = new Map(riders.map((r) => [r.id, r.name]));
  const linkByJobId = new Map<string, (typeof links)[number]>();
  for (const link of links) if (!linkByJobId.has(link.jobId)) linkByJobId.set(link.jobId, link);

  // Latest location per rider, but only for riders on a job currently
  // actively out (see LOCATION_VISIBLE_STATUSES) — never fetched otherwise.
  const ridersNeedingLocation = [
    ...new Set(
      jobs
        .filter((j) => j.riderId && LOCATION_VISIBLE_STATUSES.includes(j.status as (typeof LOCATION_VISIBLE_STATUSES)[number]))
        .map((j) => j.riderId as string),
    ),
  ];
  const locations = ridersNeedingLocation.length
    ? await ctx.prisma.riderLocation.findMany({
        where: { riderId: { in: ridersNeedingLocation } },
        orderBy: { at: "desc" },
      })
    : [];
  const latestLocationByRiderId = new Map<string, (typeof locations)[number]>();
  for (const loc of locations) if (!latestLocationByRiderId.has(loc.riderId)) latestLocationByRiderId.set(loc.riderId, loc);

  const active: CustomerPackageDto[] = [];
  const history: CustomerPackageDto[] = [];
  for (const job of jobs) {
    const customerStatus = toCustomerStatus(job.status as JobStatus);
    const pinVisible = PIN_VISIBLE_STATUSES.includes(job.status as (typeof PIN_VISIBLE_STATUSES)[number]);
    const locationVisible = job.riderId && LOCATION_VISIBLE_STATUSES.includes(job.status as (typeof LOCATION_VISIBLE_STATUSES)[number]);
    const loc = locationVisible ? latestLocationByRiderId.get(job.riderId as string) : undefined;
    const link = linkByJobId.get(job.id);

    const dto: CustomerPackageDto = {
      jobId: job.id,
      businessName: businessNameById.get(job.businessId) ?? "Business",
      jobNumber: job.jobNumber,
      itemSummary: job.itemSummary,
      customerStatus,
      scheduledAt: job.scheduledAt?.toISOString() ?? null,
      promisedAt: job.promisedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      amountExpected: moneyField(job.amountExpected, job.currency),
      paymentMethod: job.paymentMethod,
      pin: pinVisible ? job.pin : null,
      riderName: job.riderId ? (riderNameById.get(job.riderId) ?? null) : null,
      location: loc
        ? {
            point: pointFromJson(loc.point),
            trackingState: loc.trackingState as TrackingState,
            etaAt: job.routeEta?.toISOString() ?? null,
            updatedAt: loc.at.toISOString(),
          }
        : null,
      trackingUrl: link ? `${ctx.config.APP_ORIGIN}/track/${link.token}` : null,
    };

    if (TERMINAL_CUSTOMER_STATUSES.has(customerStatus)) history.push(dto);
    else active.push(dto);
  }

  return { active, history, generatedAt: new Date().toISOString() };
}

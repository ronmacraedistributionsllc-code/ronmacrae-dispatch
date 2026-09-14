import type { FastifyInstance } from "fastify";
import { httpErrors } from "@fastify/sensible";
import { money, sum } from "@ronmacrae/money";
import type { AppCtx } from "../ctx.js";
import type { CashBucketDto, RiderCashBusinessProfileDto, RiderCashMerchantProfileDto, RiderCashProfileDto } from "@ronmacrae/contracts";

/**
 * Rider cash-profile corrections (Stage 27, spec section 9) — a real,
 * precise picture of the cash a rider is holding on a business's behalf,
 * kept structurally separate from what that business owes the rider for
 * their own work.
 *
 * The whole profile is DERIVED fresh from Job rows every time it's read —
 * never a stored, mutated running total. That's not a style preference:
 * it's the actual fix for the bug the spec calls out ("Handed in must not
 * auto-clear confirmed-owed amount"). A mutable per-rider counter that
 * gets incremented on approve and decremented/reset on hand-in is exactly
 * how that bug class happens — a hand-in on one job stomping a balance
 * that reflects a *different*, already-settled job. Summing each job's
 * own amount, grouped by its own current CodStatus, at read time makes
 * that structurally impossible: a hand-in on job A only ever changes job
 * A's own row, so a "confirmed" total that sums every job B/C/D with
 * codStatus "approved" is completely untouched by it — there's no shared
 * counter for it to disturb.
 *
 * Scoped per business, always — a rider can hold active memberships at
 * more than one business (Stage 20); cash owed to business A must never
 * be summed with cash owed to business B, on either side of this.
 */

const codJobSelect = {
  codStatus: true,
  amountCollected: true,
  codHandedInAmount: true,
  currency: true,
  merchantId: true,
  merchant: { select: { name: true } },
} as const;
type CodJobRow = {
  codStatus: string;
  amountCollected: number | null;
  codHandedInAmount: number | null;
  currency: string;
  merchantId: string | null;
  merchant: { name: string } | null;
};

function bucketFor(jobs: CodJobRow[], amountField: "amountCollected" | "codHandedInAmount", fallbackField?: "amountCollected"): CashBucketDto {
  if (jobs.length === 0) return { count: 0, amount: money(0, "JMD") };
  const amounts = jobs.map((j) => money(j[amountField] ?? (fallbackField ? (j[fallbackField] ?? 0) : 0), j.currency));
  return { count: jobs.length, amount: sum(amounts) };
}

/** Same four buckets as the business-level profile, split by merchant — a
 *  rider can be holding COD for several of this business's merchants at
 *  once, and "the rider has $X" is meaningless without saying whose it is
 *  (spec: rider cash by merchant). `merchantId: null` groups this
 *  business's own direct/in-house orders (no third-party merchant). */
function buildMerchantBreakdown(codJobs: CodJobRow[]): RiderCashMerchantProfileDto[] {
  const groups = new Map<string | null, { name: string; jobs: CodJobRow[] }>();
  for (const job of codJobs) {
    const key = job.merchantId;
    const existing = groups.get(key);
    if (existing) existing.jobs.push(job);
    else groups.set(key, { name: job.merchant?.name ?? "Direct orders", jobs: [job] });
  }
  return [...groups.entries()].map(([merchantId, { name, jobs }]) => {
    const collectedJobs = jobs.filter((j) => j.codStatus === "collected");
    const handedInJobs = jobs.filter((j) => j.codStatus === "handed_in");
    const confirmedJobs = jobs.filter((j) => j.codStatus === "approved");
    const disputedJobs = jobs.filter((j) => j.codStatus === "disputed");
    const varianceSource = [...handedInJobs, ...confirmedJobs];
    return {
      merchantId,
      merchantName: name,
      collected: bucketFor(collectedJobs, "amountCollected"),
      handedInUnconfirmed: bucketFor(handedInJobs, "codHandedInAmount"),
      confirmed: bucketFor(confirmedJobs, "codHandedInAmount"),
      disputed: bucketFor(disputedJobs, "codHandedInAmount", "amountCollected"),
      handoverVariance:
        varianceSource.length === 0
          ? money(0, "JMD")
          : sum(varianceSource.map((j) => money((j.codHandedInAmount ?? 0) - (j.amountCollected ?? 0), j.currency))),
    };
  });
}

async function buildBusinessProfile(ctx: AppCtx, riderId: string, businessId: string): Promise<RiderCashBusinessProfileDto> {
  const [business, rider, codJobs, deliveredCount] = await Promise.all([
    ctx.prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
    ctx.prisma.rider.findUnique({ where: { id: riderId }, select: { payRate: true, payCurrency: true } }),
    ctx.prisma.job.findMany({
      where: { riderId, businessId, paymentMethod: "cod", codStatus: { in: ["collected", "handed_in", "approved", "disputed"] } },
      select: codJobSelect,
    }),
    // Global by design (like the rider's own dailyCapacity/pay rate — see
    // riders.ts's precedent) would be wrong here: earnings owed *by this
    // business* must only count deliveries actually made *for* it.
    ctx.prisma.job.count({ where: { riderId, businessId, status: "delivered" } }),
  ]);
  if (!business) throw httpErrors.createError(404, "Business not found");
  if (!rider) throw httpErrors.createError(404, "Courier not found");

  const collectedJobs = codJobs.filter((j) => j.codStatus === "collected");
  const handedInJobs = codJobs.filter((j) => j.codStatus === "handed_in");
  const confirmedJobs = codJobs.filter((j) => j.codStatus === "approved");
  // A dispute can be raised straight from "collected" (before any hand-in
  // was ever recorded) or from "handed_in"/"approved" — codHandedInAmount
  // may genuinely be unset in the first case, so fall back to what was
  // recorded collected rather than silently showing $0 for a real dispute.
  const disputedJobs = codJobs.filter((j) => j.codStatus === "disputed");

  const collected = bucketFor(collectedJobs, "amountCollected");
  const handedInUnconfirmed = bucketFor(handedInJobs, "codHandedInAmount");
  const confirmed = bucketFor(confirmedJobs, "codHandedInAmount");
  const disputed = bucketFor(disputedJobs, "codHandedInAmount", "amountCollected");

  // A real shortage (negative) or overage (positive) between what the
  // rider says they collected and what actually reached the office,
  // across every job that's gotten at least as far as a hand-in — never
  // silently netted away inside either bucket's own total.
  const varianceSource = [...handedInJobs, ...confirmedJobs];
  const handoverVariance =
    varianceSource.length === 0
      ? money(0, "JMD")
      : sum(varianceSource.map((j) => money((j.codHandedInAmount ?? 0) - (j.amountCollected ?? 0), j.currency)));

  const earningsPayable = rider.payRate != null ? money(rider.payRate * deliveredCount, rider.payCurrency) : null;
  const earningsNote =
    rider.payRate == null
      ? "No pay rate configured for this courier — earnings are shown as not set, never $0."
      : "Estimate only: pay rate × delivered jobs at this business to date. No payout-tracking exists yet (Payout/PayoutLine are unused), so this never decreases as money is actually paid out — see WORK_IN_PROGRESS.md's Stage 27 notes.";

  return {
    businessId,
    businessName: business.name,
    collected,
    handedInUnconfirmed,
    confirmed,
    disputed,
    handoverVariance,
    earningsPayable,
    earningsNote,
    byMerchant: buildMerchantBreakdown(codJobs),
  };
}

export async function buildRiderCashProfile(ctx: AppCtx, riderId: string, businessIds?: string[]): Promise<RiderCashProfileDto> {
  const rider = await ctx.prisma.rider.findUnique({ where: { id: riderId }, select: { name: true } });
  if (!rider) throw httpErrors.createError(404, "Courier not found");

  const ids =
    businessIds ??
    (
      await ctx.prisma.riderMembership.findMany({ where: { riderId, status: "active" }, select: { businessId: true } })
    ).map((m) => m.businessId);

  const businesses = await Promise.all(ids.map((businessId) => buildBusinessProfile(ctx, riderId, businessId)));
  return { riderId, riderName: rider.name, businesses };
}

export async function cashProfileRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  // The rider's own view — every active business membership they hold,
  // never combined into one cross-business figure (see this file's own
  // doc comment).
  app.get("/api/bearer/cash", { preHandler: ctx.requireRider }, async (req) => {
    return buildRiderCashProfile(ctx, req.user!.riderId!);
  });

  // Staff view — this business's own slice of a rider's cash profile
  // only, even for a rider shared with other businesses. Monitor roles
  // (accountant/viewer) can read; nothing here is written by this route.
  app.get<{ Params: { id: string } }>(
    "/api/riders/:id/cash",
    { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") },
    async (req) => {
      const businessId = req.user!.businessId!;
      const membership = await ctx.prisma.riderMembership.findUnique({
        where: { riderId_businessId: { riderId: req.params.id, businessId } },
      });
      // 404, not 403 — a business must never learn whether a rider id
      // exists at all if they've never worked together, same rule as
      // every other cross-business boundary in this codebase.
      if (!membership) throw httpErrors.createError(404, "Courier not found");
      return buildRiderCashProfile(ctx, req.params.id, [businessId]);
    },
  );
}

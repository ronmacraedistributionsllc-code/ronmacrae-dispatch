import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { AppCtx } from "../ctx.js";
import type {
  JobStatus,
  OperatingReportDto,
  OperatingReportFilters,
  OperatingReportLogisticsRowDto,
  OperatingReportRiderRowDto,
  OperatingReportRowDto,
} from "@ronmacrae/contracts";
import type { Money } from "@ronmacrae/money";
import { moneyField } from "../geo-mappers.js";

const FAILED_CANCELLED_STATUSES: JobStatus[] = ["failed", "cancelled", "returned"];

function bucketFor(status: JobStatus): "completed" | "active" | "failed_cancelled" {
  if (status === "delivered") return "completed";
  if (FAILED_CANCELLED_STATUSES.includes(status)) return "failed_cancelled";
  return "active";
}

const ReportQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  riderId: z.string().optional(),
  zoneId: z.string().optional(),
  bucket: z.enum(["completed", "active", "failed_cancelled"]).optional(),
  paymentMethod: z.string().optional(),
  /** Stage 39: restricts to jobs completed by a rider currently attached
   *  to this logistics company — see OperatingReportLogisticsRowDto. */
  logisticsCompanyId: z.string().optional(),
});
type ReportQueryInput = z.infer<typeof ReportQuery>;

async function buildReport(ctx: AppCtx, businessId: string, q: ReportQueryInput): Promise<OperatingReportDto> {
  const cur = ctx.config.OPERATIONAL_CURRENCY;
  const where: Prisma.JobWhereInput = {
    businessId,
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
    ...(q.riderId ? { riderId: q.riderId } : {}),
    ...(q.zoneId ? { zoneId: q.zoneId } : {}),
    ...(q.paymentMethod ? { paymentMethod: q.paymentMethod as Prisma.JobWhereInput["paymentMethod"] } : {}),
    // A job has no direct link to a logistics company — this filters by
    // whichever company the assigned rider is CURRENTLY attached to, same
    // indirection byLogisticsCompany's own grouping below uses.
    ...(q.logisticsCompanyId ? { rider: { attachedLogisticsCompanyId: q.logisticsCompanyId } } : {}),
  };
  const jobs = await ctx.prisma.job.findMany({
    where,
    include: {
      customer: { select: { name: true } },
      rider: { select: { id: true, name: true, payRate: true, payCurrency: true, attachedLogisticsCompanyId: true, attachedLogisticsCompany: { select: { name: true } } } },
      zone: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const notes: string[] = [];
  const filteredJobs = q.bucket ? jobs.filter((j) => bucketFor(j.status) === q.bucket) : jobs;

  const rows: OperatingReportRowDto[] = filteredJobs.map((j) => {
    const bucket = bucketFor(j.status);
    const deliveryTimeMs = j.completedAt ? j.completedAt.getTime() - j.createdAt.getTime() : null;
    return {
      jobId: j.id,
      jobNumber: j.jobNumber,
      createdAt: j.createdAt.toISOString(),
      completedAt: j.completedAt?.toISOString() ?? null,
      status: j.status,
      bucket,
      urgent: j.priority === "urgent",
      zoneName: j.zone?.name ?? null,
      riderId: j.riderId,
      riderName: j.rider?.name ?? null,
      customerName: j.customer.name,
      paymentMethod: j.paymentMethod,
      deliveryFee: moneyField(j.fee, j.currency),
      amountExpected: moneyField(j.amountExpected, j.currency),
      amountCollected: moneyField(j.amountCollected, j.currency),
      codHandedInAmount: moneyField(j.codHandedInAmount, j.currency),
      deliveryTimeMs,
    };
  });

  // Summary totals are computed over the *unfiltered-by-bucket* set for the
  // three bucket counts (so switching the bucket filter doesn't change what
  // "completed" means elsewhere), but over `rows` (bucket-filtered) for
  // everything money/time-related, so a CSV scoped to one bucket has
  // matching totals.
  let deliveryFeesMinor = 0;
  let codExpectedMinor = 0;
  let codCollectedMinor = 0;
  let codHandedInMinor = 0;
  let codOutstandingMinor = 0;
  let codShortageMinor = 0;
  let codOverageMinor = 0;
  let urgentCount = 0;
  let offCurrencyCount = 0;
  const deliveryTimes: number[] = [];

  for (const j of filteredJobs) {
    if (j.currency !== cur) {
      offCurrencyCount += 1;
      continue; // excluded from sums, kept in the per-job rows for visibility
    }
    if (j.priority === "urgent") urgentCount += 1;
    if (j.fee != null) deliveryFeesMinor += j.fee;
    if (j.paymentMethod === "cod") {
      const expected = j.amountExpected ?? 0;
      const collected = j.amountCollected ?? 0;
      codExpectedMinor += expected;
      codCollectedMinor += collected;
      if (j.codHandedInAmount != null) {
        codHandedInMinor += j.codHandedInAmount;
        const variance = j.codHandedInAmount - collected;
        if (variance < 0) codShortageMinor += -variance;
        else codOverageMinor += variance;
      }
      if (expected > collected) codOutstandingMinor += expected - collected;
    }
    if (j.status === "delivered" && j.completedAt) deliveryTimes.push(j.completedAt.getTime() - j.createdAt.getTime());
  }
  if (offCurrencyCount > 0) {
    notes.push(`${offCurrencyCount} job(s) use a different currency than ${cur} and are excluded from the money totals above (still listed in the rows/CSV).`);
  }

  const byRiderMap = new Map<string, { name: string; completed: number; payRate: number | null; payCurrency: string }>();
  for (const j of filteredJobs) {
    if (j.status !== "delivered" || !j.rider) continue;
    const existing = byRiderMap.get(j.rider.id);
    if (existing) existing.completed += 1;
    else byRiderMap.set(j.rider.id, { name: j.rider.name, completed: 1, payRate: j.rider.payRate, payCurrency: j.rider.payCurrency });
  }
  const byRider: OperatingReportRiderRowDto[] = [...byRiderMap.entries()]
    .map(([riderId, r]): OperatingReportRiderRowDto => ({
      riderId,
      riderName: r.name,
      jobsCompleted: r.completed,
      estimatedEarnings: r.payRate != null ? moneyField(r.payRate * r.completed, r.payCurrency) : null,
    }))
    .sort((a, b) => b.jobsCompleted - a.jobsCompleted);
  const noRateCount = byRider.filter((r) => r.estimatedEarnings == null).length;
  if (noRateCount > 0) {
    notes.push(`${noRateCount} courier(s) with completed deliveries have no configured pay rate — their earnings are shown as "not set", not $0, and excluded from any earnings total.`);
  }

  // Stage 39 (spec: "reports broken out by logistics company") — a job has
  // no direct link to a company, so this groups by whichever company the
  // completing rider is CURRENTLY attached to (Rider.attachedLogisticsCompanyId).
  // A freelance/merchant-attached rider's completed jobs count toward
  // neither this table nor any company total — see unattachedJobsCompleted.
  const byLogisticsCompanyMap = new Map<string, { name: string; jobsCompleted: number; riderIds: Set<string> }>();
  let unattachedJobsCompleted = 0;
  for (const j of filteredJobs) {
    if (j.status !== "delivered" || !j.rider) continue;
    const companyId = j.rider.attachedLogisticsCompanyId;
    if (!companyId) {
      unattachedJobsCompleted += 1;
      continue;
    }
    const existing = byLogisticsCompanyMap.get(companyId);
    if (existing) {
      existing.jobsCompleted += 1;
      existing.riderIds.add(j.rider.id);
    } else {
      byLogisticsCompanyMap.set(companyId, { name: j.rider.attachedLogisticsCompany?.name ?? "Unknown", jobsCompleted: 1, riderIds: new Set([j.rider.id]) });
    }
  }
  const byLogisticsCompany: OperatingReportLogisticsRowDto[] = [...byLogisticsCompanyMap.entries()]
    .map(([logisticsCompanyId, c]): OperatingReportLogisticsRowDto => ({
      logisticsCompanyId,
      logisticsCompanyName: c.name,
      jobsCompleted: c.jobsCompleted,
      riderCount: c.riderIds.size,
    }))
    .sort((a, b) => b.jobsCompleted - a.jobsCompleted);

  const completedCount = jobs.filter((j) => bucketFor(j.status) === "completed").length;
  const activeCount = jobs.filter((j) => bucketFor(j.status) === "active").length;
  const failedCancelledCount = jobs.filter((j) => bucketFor(j.status) === "failed_cancelled").length;

  const filters: OperatingReportFilters = {
    from: q.from ?? null,
    to: q.to ?? null,
    riderId: q.riderId ?? null,
    zoneId: q.zoneId ?? null,
    bucket: q.bucket ?? null,
    paymentMethod: q.paymentMethod ?? null,
    logisticsCompanyId: q.logisticsCompanyId ?? null,
  };

  const money = (minor: number): Money => ({ amount: minor, currency: cur });

  return {
    filters,
    summary: {
      deliveriesCompleted: completedCount,
      deliveriesActive: activeCount,
      deliveriesFailedCancelled: failedCancelledCount,
      urgentDeliveryCount: urgentCount,
      deliveryFeesCharged: money(deliveryFeesMinor),
      codExpected: money(codExpectedMinor),
      codCollected: money(codCollectedMinor),
      codHandedIn: money(codHandedInMinor),
      codOutstanding: money(codOutstandingMinor),
      codShortageTotal: money(codShortageMinor),
      codOverageTotal: money(codOverageMinor),
      averageDeliveryTimeMs: deliveryTimes.length > 0 ? Math.round(deliveryTimes.reduce((a, b) => a + b, 0) / deliveryTimes.length) : null,
      averageDeliveryTimeSampleSize: deliveryTimes.length,
      unattachedJobsCompleted,
    },
    byRider,
    byLogisticsCompany,
    rows,
    notes,
    generatedAt: new Date().toISOString(),
  };
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function reportToCsv(report: OperatingReportDto): string {
  const headers = [
    "jobNumber", "createdAt", "completedAt", "status", "bucket", "urgent", "zone", "rider", "customerName",
    "paymentMethod", "deliveryFee", "amountExpected", "amountCollected", "codHandedIn", "deliveryTimeMinutes",
  ];
  const lines = [headers.join(",")];
  for (const r of report.rows) {
    lines.push(
      [
        r.jobNumber ?? r.jobId.slice(0, 8),
        r.createdAt,
        r.completedAt ?? "",
        r.status,
        r.bucket,
        r.urgent ? "yes" : "no",
        r.zoneName ?? "",
        r.riderName ?? "",
        r.customerName,
        r.paymentMethod,
        r.deliveryFee ? String(r.deliveryFee.amount) : "",
        r.amountExpected ? String(r.amountExpected.amount) : "",
        r.amountCollected ? String(r.amountCollected.amount) : "",
        r.codHandedInAmount ? String(r.codHandedInAmount.amount) : "",
        r.deliveryTimeMs != null ? String(Math.round(r.deliveryTimeMs / 60_000)) : "",
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  return lines.join("\n");
}

export async function reportRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const authorized = ctx.requireStaff("admin", "accountant");

  app.get("/api/reports/summary", { preHandler: authorized }, async (req) => {
    const q = ReportQuery.parse(req.query);
    return buildReport(ctx, req.user!.businessId!, q);
  });

  app.get("/api/reports/jobs.csv", { preHandler: authorized }, async (req, reply) => {
    const q = ReportQuery.parse(req.query);
    const report = await buildReport(ctx, req.user!.businessId!, q);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "report.export_csv", "report", "operating", { filters: report.filters });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="operating-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reportToCsv(report);
  });
}

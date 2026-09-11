import type { Prisma, PrismaClient } from "@prisma/client";
import type { AppCtx } from "../../ctx.js";
import type { GeoPoint, JobStatus } from "@ronmacrae/contracts";
import { pointFromJson } from "../../geo-mappers.js";
import { jobInclude, type JobRow } from "./dto.js";

type Db = Pick<AppCtx, "prisma">;

/** Sort orders supported by the job list. */
export type JobSort = "newest" | "oldest" | "scheduled";

export interface JobListFilter {
  /** Omit only for a rider's own cross-business job list — every staff-facing
   *  list MUST pass this, since it's the entire isolation boundary. */
  businessId?: string;
  status?: JobStatus | JobStatus[];
  source?: string;
  riderId?: string;
  customerId?: string;
  /** matches job number, external ref, address or customer name/phone */
  search?: string;
  /** ISO dates on createdAt */
  from?: string;
  to?: string;
  take?: number;
  skip?: number;
  sort?: JobSort;
  /** Trash (Stage 26, spec 8). Every ordinary caller leaves this unset,
   *  which excludes soft-deleted jobs — the default, and the only mode
   *  every existing call site before this stage ever used. `true` is the
   *  opposite: only soft-deleted jobs (the trash view itself). There is
   *  deliberately no "include everything" mode — a caller that wants both
   *  makes that an explicit choice, not an easy-to-forget default. */
  deleted?: boolean;
}

export function jobListWhere(f: JobListFilter): Prisma.JobWhereInput {
  const or: Prisma.JobWhereInput[] = [];
  const s = f.search?.trim().toLowerCase();
  if (s) {
    or.push({
      OR: [
        { jobNumber: { contains: s } },
        { externalRef: { contains: s } },
        { addressText: { contains: s } },
        { customer: { name: { contains: s } } },
        { customer: { phone: { contains: s.replace(/[^\d]/g, "") } } },
      ],
    });
  }
  return {
    ...(f.businessId ? { businessId: f.businessId } : {}),
    ...(f.status ? { status: Array.isArray(f.status) ? { in: f.status } : f.status } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.riderId ? { riderId: f.riderId } : {}),
    ...(f.customerId ? { customerId: f.customerId } : {}),
    ...(f.from || f.to
      ? { createdAt: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } }
      : {}),
    deletedAt: f.deleted ? { not: null } : null,
    ...(or.length > 0 ? { OR: or } : {}),
  };
}

export async function listJobs(db: Db, f: JobListFilter): Promise<JobRow[]> {
  return db.prisma.job.findMany({
    where: jobListWhere(f),
    orderBy:
      f.sort === "oldest"
        ? { createdAt: "asc" }
        : f.sort === "scheduled"
          ? [{ scheduledAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }]
          : { createdAt: "desc" },
    take: Math.min(f.take ?? 50, 200),
    skip: f.skip ?? 0,
    include: jobInclude,
  });
}

export async function countJobs(db: Db, f: JobListFilter): Promise<number> {
  return db.prisma.job.count({ where: jobListWhere(f) });
}

/** Every ordinary job action (assign, transition, messages, proofs,
 *  offers, COD collection, tracking...) goes through this — excluding a
 *  soft-deleted job here, once, makes it uniformly invisible to all of
 *  them (a 404, same as any other missing job) without touching each of
 *  those call sites individually. Trash-specific code (restore, the trash
 *  list itself) uses getJobRowAnyDeletionState instead, and reports/COD-
 *  reconciliation/audit never go through either of these — they query
 *  Job/CodEvent/AuditLog directly, deliberately unfiltered by deletedAt
 *  (see schema.prisma's own note on Job.deletedAt for why). */
export async function getJobRow(db: Db, id: string): Promise<JobRow | null> {
  return db.prisma.job.findUnique({ where: { id, deletedAt: null }, include: jobInclude });
}

/** The one exception to getJobRow's deleted-is-invisible rule — used only
 *  by jobs/trash.ts, which by definition needs to find a job regardless
 *  of its deletion state (to restore it, or to show it in the trash). */
export async function getJobRowAnyDeletionState(db: Db, id: string): Promise<JobRow | null> {
  return db.prisma.job.findUnique({ where: { id }, include: jobInclude });
}

/** Job numbers are only unique per business now (see the schema's
 *  `@@unique([businessId, jobNumber])`) — resolving by number alone, without
 *  a businessId, is deliberately not offered any more; callers that used to
 *  do a global "RM-000123" lookup now scope it to their own business. */
export async function getJobByNumber(db: Db, businessId: string, jobNumber: string): Promise<JobRow | null> {
  const trimmed = jobNumber.trim().toUpperCase();
  const direct = await db.prisma.job.findUnique({ where: { businessId_jobNumber: { businessId, jobNumber: trimmed } }, include: jobInclude });
  if (direct) return direct;
  // allow "rm-000042"
  return db.prisma.job.findUnique({ where: { businessId_jobNumber: { businessId, jobNumber: jobNumber.trim() } }, include: jobInclude });
}

/** `RM-000123` style numbers; derived from the highest existing one. */
export function formatJobNumber(n: number): string {
  return `RM-${String(Math.max(1, n)).padStart(6, "0")}`;
}

/** Job numbers are per-business (each business's own RM-000001, RM-000002...
 *  sequence) — matches the schema's `@@unique([businessId, jobNumber])`, and
 *  means a business's own order count is never inferable from another
 *  business's numbering. */
export async function nextJobNumber(db: Db, businessId: string): Promise<string> {
  const last = await db.prisma.job.findFirst({ where: { businessId }, orderBy: { jobNumber: "desc" }, select: { jobNumber: true } });
  const raw = last?.jobNumber?.split("-")[1] ?? "";
  const n = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
  return formatJobNumber(n + 1);
}

/** True when the error is a unique-constraint violation (Prisma P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}

export async function listEvents(db: Db, jobId: string) {
  return db.prisma.jobEvent.findMany({ where: { jobId }, orderBy: { at: "asc" } });
}

export async function listAssignments(db: Db, jobId: string) {
  return db.prisma.riderAssignment.findMany({
    where: { jobId },
    orderBy: { at: "asc" },
    include: { rider: { select: { name: true } } },
  });
}

export interface ActiveJobRow {
  id: string;
  riderId: string;
  status: string;
}

/** Jobs a rider is actively working (owns the package / resolving). */
export async function activeJobsForRider(db: Db, riderId: string, statuses: readonly string[]): Promise<ActiveJobRow[]> {
  const rows = await db.prisma.job.findMany({
    where: { riderId, status: { in: [...statuses] as JobStatus[] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, riderId: true, status: true },
  });
  return rows.map((r) => ({ id: r.id, riderId: r.riderId ?? riderId, status: r.status }));
}

export async function activeJobCount(db: Db, riderId: string, statuses: readonly string[]): Promise<number> {
  return db.prisma.job.count({ where: { riderId, status: { in: [...statuses] as JobStatus[] } } });
}

/** Most recent reported/simulated location of a rider, if any. */
export async function latestRiderPoint(db: Db, riderId: string): Promise<GeoPoint | null> {
  const row = await db.prisma.riderLocation.findFirst({ where: { riderId }, orderBy: { at: "desc" } });
  return row ? pointFromJson(row.point) : null;
}

/** The `return` job linked to an original, when one exists. */
export async function returnJobFor(db: Db, originalJobId: string): Promise<string | null> {
  const row = await db.prisma.job.findFirst({
    where: { originalJobId, type: "return" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** Rider referenced by a job (null when unassigned). */
export async function jobRider(db: Db, riderId: string | null) {
  if (!riderId) return null;
  return db.prisma.rider.findUnique({ where: { id: riderId } });
}

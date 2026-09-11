#!/usr/bin/env node
/**
 * Stage 26 — deleted-orders trash: the "scheduled purge" job.
 *
 * Does NOT delete anything. There is nothing to delete: a soft-deleted Job
 * row (and everything referencing it — CodEvent, JobEvent, DeliveryMessage,
 * etc., all `onDelete: Cascade`) is never actually removed by this
 * codebase, on purpose (see schema.prisma's own note on Job.deletedAt —
 * the ledger/dispute/audit trail would go with it). Restore-eligibility
 * is computed live from `deletedAt` (jobs/trash.ts's isPurged()), so it's
 * always correct with or without this script ever running.
 *
 * What this script actually does: for every soft-deleted job that has
 * newly crossed the 30-day mark since it last ran, record one AuditLog
 * entry ("job.purged") — a real, permanent, queryable record of exactly
 * when restore stopped being offered for it. Idempotent (skips jobs
 * already recorded), safe to run from any real scheduler (cron, launchd,
 * a hosting platform's scheduled-job feature) on any cadence, or not at
 * all — nothing about trash/restore behavior depends on it.
 *
 * Usage (from apps/api, with DATABASE_URL pointing at the dev.db to check):
 *   node scripts/purge-deleted-jobs.mjs          # dry run (default)
 *   node scripts/purge-deleted-jobs.mjs --yes    # record the audit entries
 */
import { PrismaClient } from "@prisma/client";

const yes = process.argv.slice(2).includes("--yes");
const prisma = new PrismaClient();
const PURGE_DAYS = 30;

async function main() {
  const cutoff = new Date(Date.now() - PURGE_DAYS * 24 * 3600_000);
  const candidates = await prisma.job.findMany({
    where: { deletedAt: { lte: cutoff } },
    select: { id: true, businessId: true, jobNumber: true, deletedAt: true, deletedById: true },
  });
  if (candidates.length === 0) {
    console.log("[purge-deleted-jobs] nothing crosses the 30-day mark right now.");
    return;
  }

  const jobIds = candidates.map((j) => j.id);
  const alreadyRecorded = await prisma.auditLog.findMany({
    where: { action: "job.purged", entityId: { in: jobIds } },
    select: { entityId: true },
  });
  const recordedIds = new Set(alreadyRecorded.map((r) => r.entityId));
  const toRecord = candidates.filter((j) => !recordedIds.has(j.id));

  console.log(
    `[purge-deleted-jobs] ${candidates.length} job(s) past the ${PURGE_DAYS}-day restore window; ` +
      `${toRecord.length} not yet recorded, ${candidates.length - toRecord.length} already have a job.purged entry.`,
  );

  if (!yes) {
    console.log("[purge-deleted-jobs] dry run only — pass --yes to record the audit entries.");
    return;
  }

  for (const job of toRecord) {
    await prisma.auditLog.create({
      data: {
        action: "job.purged",
        entityType: "job",
        entityId: job.id,
        businessId: job.businessId,
        role: "system",
        meta: { jobNumber: job.jobNumber, deletedAt: job.deletedAt?.toISOString(), deletedById: job.deletedById },
      },
    });
  }
  console.log(`[purge-deleted-jobs] recorded ${toRecord.length} job.purged entr${toRecord.length === 1 ? "y" : "ies"}.`);
}

main()
  .catch((err) => {
    console.error("[purge-deleted-jobs] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

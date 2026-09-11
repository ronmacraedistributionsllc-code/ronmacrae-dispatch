#!/usr/bin/env node
/**
 * Stage 22 — outbox isolation backfill.
 *
 * `OutboxMessage.businessId` was added nullable (see schema.prisma) so the
 * schema push itself was purely additive; this script fills it in on every
 * pre-existing row by copying it from the row's own linked Job
 * (`OutboxMessage.jobId` -> `Job.businessId`). Rows with no jobId are left
 * null on purpose — a message with no owning job has no single business to
 * attribute it to (see notify.ts's list()/retry(), which now require a
 * businessId match and so never show a null-businessId row to any staff).
 *
 * Why this exists at all: `GET /api/notifications` filtered by nothing but
 * an optional jobId — any staff member at any business could list (or
 * retry) every business's customer notifications, including full message
 * text and tracking-link tokens. Found while building Stage 22's
 * customer-dashboard access-code flow, which sends its own notifications
 * through this same outbox.
 *
 * Safety: dry-run by default (prints what it would change, changes nothing,
 * exits 0). Pass --yes to actually execute. One transaction.
 *
 * Usage (from apps/api, with DATABASE_URL pointing at the dev.db to fix):
 *   node scripts/backfill-outbox-business.mjs          # dry run
 *   node scripts/backfill-outbox-business.mjs --yes    # actually backfill
 */
import { PrismaClient } from "@prisma/client";

const yes = process.argv.slice(2).includes("--yes");
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.outboxMessage.findMany({
    where: { businessId: null, jobId: { not: null } },
    select: { id: true, jobId: true },
  });
  if (rows.length === 0) {
    console.log("[backfill-outbox-business] nothing to do — no job-linked row is missing businessId.");
    return;
  }

  const jobIds = [...new Set(rows.map((r) => r.jobId))];
  const jobs = await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, businessId: true } });
  const businessByJob = new Map(jobs.map((j) => [j.id, j.businessId]));

  const plan = rows
    .map((r) => ({ id: r.id, jobId: r.jobId, businessId: businessByJob.get(r.jobId ?? "") ?? null }))
    .filter((p) => p.businessId);
  const orphaned = rows.length - plan.length;

  console.log(`[backfill-outbox-business] ${rows.length} job-linked message(s) missing businessId; ${plan.length} resolvable via their job, ${orphaned} orphaned (job no longer exists — left null).`);

  if (!yes) {
    console.log("[backfill-outbox-business] dry run only — pass --yes to apply.");
    return;
  }

  await prisma.$transaction(plan.map((p) => prisma.outboxMessage.update({ where: { id: p.id }, data: { businessId: p.businessId } })));
  console.log(`[backfill-outbox-business] updated ${plan.length} row(s).`);
}

main()
  .catch((err) => {
    console.error("[backfill-outbox-business] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

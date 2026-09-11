#!/usr/bin/env node
/**
 * Stage 23 — audit-log isolation backfill.
 *
 * `AuditLog.businessId` was added nullable (see schema.prisma) so the
 * schema push itself was purely additive; this script fills it in on
 * every pre-existing "job"/"customer"/"offer" entry by joining to that
 * entity's own businessId — the same derivation audit.ts's record() now
 * does automatically for every new entry going forward. "rider"/"user"
 * entries are left null on purpose: a rider being created, or a staff
 * login, isn't any one business's event (riders are global; StaffMembership
 * is the business-specific link) — that's a real, correct distinction, not
 * a gap in this script.
 *
 * Why this exists: GET /api/audit had no business filter at all — any
 * staff member at any business could read every other business's entire
 * audit trail. Found while building Stage 23's identity duplicate-
 * resolution, which needed its own merge events to stay platform-level
 * without also widening the existing leak.
 *
 * Safety: dry-run by default (prints what it would change, changes
 * nothing, exits 0). Pass --yes to actually execute. One transaction.
 *
 * Usage (from apps/api, with DATABASE_URL pointing at the dev.db to fix):
 *   node scripts/backfill-audit-business.mjs          # dry run
 *   node scripts/backfill-audit-business.mjs --yes    # actually backfill
 */
import { PrismaClient } from "@prisma/client";

const yes = process.argv.slice(2).includes("--yes");
const prisma = new PrismaClient();
const DERIVABLE_TYPES = ["job", "customer", "offer"];

async function main() {
  const rows = await prisma.auditLog.findMany({
    where: { businessId: null, entityType: { in: DERIVABLE_TYPES }, entityId: { not: null } },
    select: { id: true, entityType: true, entityId: true },
  });
  if (rows.length === 0) {
    console.log("[backfill-audit-business] nothing to do — no derivable row is missing businessId.");
    return;
  }

  const jobIds = [...new Set(rows.filter((r) => r.entityType === "job").map((r) => r.entityId))];
  const customerIds = [...new Set(rows.filter((r) => r.entityType === "customer").map((r) => r.entityId))];
  const offerIds = [...new Set(rows.filter((r) => r.entityType === "offer").map((r) => r.entityId))];

  const [jobs, customers, offers] = await Promise.all([
    jobIds.length ? prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, businessId: true } }) : [],
    customerIds.length ? prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, businessId: true } }) : [],
    offerIds.length ? prisma.jobOffer.findMany({ where: { id: { in: offerIds } }, select: { id: true, businessId: true } }) : [],
  ]);
  const businessByJob = new Map(jobs.map((j) => [j.id, j.businessId]));
  const businessByCustomer = new Map(customers.map((c) => [c.id, c.businessId]));
  const businessByOffer = new Map(offers.map((o) => [o.id, o.businessId]));

  const lookup = { job: businessByJob, customer: businessByCustomer, offer: businessByOffer };
  const plan = rows
    .map((r) => ({ id: r.id, businessId: lookup[r.entityType].get(r.entityId) ?? null }))
    .filter((p) => p.businessId);
  const orphaned = rows.length - plan.length;

  console.log(
    `[backfill-audit-business] ${rows.length} derivable entr(y/ies) missing businessId; ` +
      `${plan.length} resolvable, ${orphaned} orphaned (the entity no longer exists — left null).`,
  );

  if (!yes) {
    console.log("[backfill-audit-business] dry run only — pass --yes to apply.");
    return;
  }

  // Batched (not one update per row — 1300+ rows in the real dev.db) but
  // still grouped by businessId so it stays a small, bounded number of
  // statements rather than 1300+ individual ones.
  const idsByBusiness = new Map();
  for (const p of plan) {
    if (!idsByBusiness.has(p.businessId)) idsByBusiness.set(p.businessId, []);
    idsByBusiness.get(p.businessId).push(p.id);
  }
  await prisma.$transaction(
    [...idsByBusiness.entries()].map(([businessId, ids]) =>
      prisma.auditLog.updateMany({ where: { id: { in: ids } }, data: { businessId } }),
    ),
  );
  console.log(`[backfill-audit-business] updated ${plan.length} row(s) across ${idsByBusiness.size} business(es).`);
}

main()
  .catch((err) => {
    console.error("[backfill-audit-business] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

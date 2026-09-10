#!/usr/bin/env node
/**
 * Stage 11 — removes every rider except the one real one (Kei Bearer,
 * +8765550001), safely cleaning up each removed rider's disposable records
 * first. Preserves everything else untouched: staff/admin accounts, customers,
 * zones, fees, settings, and all Job records (a job that pointed at a removed
 * rider is left in place with `riderId` set to null — the schema does this for
 * us via `Job.rider`'s `onDelete: SetNull`, so job/order history survives even
 * though the test-only rider who happened to be attached to it does not).
 *
 * Every relation from Rider that is NOT Job cascades on delete (see
 * `schema.prisma`): JobOffer, RiderAssignment, Route, RiderLocation,
 * ReconDaily, Payout, SosAlert. A rider's login (User row, if it had a
 * password) is deleted separately right after, which cascades that user's
 * Session and PushSubscription rows too — Prisma's SQLite connector always
 * runs with `PRAGMA foreign_keys = ON`, so these cascades are enforced by the
 * database itself, the same way the running app relies on them.
 *
 * Safety:
 *  - Dry-run by default — prints exactly what would happen and exits 0
 *    without changing anything. Pass --yes to actually execute.
 *  - Refuses to run at all unless it finds EXACTLY ONE rider matching the kept
 *    phone number (so a bad phone/typo, or that rider somehow being missing,
 *    fails loudly instead of silently deleting everyone).
 *  - Whole deletion runs inside one Prisma transaction: either every removed
 *    rider is fully cleaned up, or (on any error) nothing is.
 *  - Prints before/after row counts for every affected table, and explicitly
 *    confirms the tables that must be byte-for-byte unchanged in row count.
 *
 * Usage (from apps/api, with DATABASE_URL pointing at the dev.db to clean):
 *   node scripts/remove-test-riders.mjs                # dry run (default)
 *   node scripts/remove-test-riders.mjs --yes           # actually delete
 *   node scripts/remove-test-riders.mjs --yes --keep-phone=+8765550001
 */
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const keepPhoneArg = args.find((a) => a.startsWith("--keep-phone="));
const keepPhone = keepPhoneArg ? keepPhoneArg.slice("--keep-phone=".length) : "+8765550001";

const prisma = new PrismaClient();

async function countAll() {
  const [riders, users, staffUsers, customers, zones, settings, jobs, offers, assignments, locations, pushSubs, sessions, routes, recon, payouts, sos] =
    await Promise.all([
      prisma.rider.count(),
      prisma.user.count(),
      prisma.user.count({ where: { role: { not: "rider" } } }),
      prisma.customer.count(),
      prisma.zone.count(),
      prisma.setting.count(),
      prisma.job.count(),
      prisma.jobOffer.count(),
      prisma.riderAssignment.count(),
      prisma.riderLocation.count(),
      prisma.pushSubscription.count(),
      prisma.session.count(),
      prisma.route.count(),
      prisma.reconDaily.count(),
      prisma.payout.count(),
      prisma.sosAlert.count(),
    ]);
  return { riders, users, staffUsers, customers, zones, settings, jobs, offers, assignments, locations, pushSubs, sessions, routes, recon, payouts, sos };
}

async function main() {
  const keeper = await prisma.rider.findMany({ where: { phone: keepPhone } });
  if (keeper.length !== 1) {
    console.error(
      `Refusing to run: expected exactly 1 rider with phone ${keepPhone}, found ${keeper.length}. ` +
        `Fix the phone number or the data before running this again.`,
    );
    process.exitCode = 1;
    return;
  }
  const keepId = keeper[0].id;
  console.log(`Keeping rider: ${keeper[0].name} (${keeper[0].phone}, id ${keepId})`);

  const toRemove = await prisma.rider.findMany({
    where: { id: { not: keepId } },
    select: { id: true, name: true, phone: true, userId: true },
  });
  if (toRemove.length === 0) {
    console.log("No other riders exist — nothing to do.");
    return;
  }

  const before = await countAll();
  const idsToRemove = toRemove.map((r) => r.id);
  const [jobsToUnassign, offersToRemove, assignmentsToRemove, locationsToRemove, routesToRemove, reconToRemove, payoutsToRemove, sosToRemove] =
    await Promise.all([
      prisma.job.count({ where: { riderId: { in: idsToRemove } } }),
      prisma.jobOffer.count({ where: { riderId: { in: idsToRemove } } }),
      prisma.riderAssignment.count({ where: { riderId: { in: idsToRemove } } }),
      prisma.riderLocation.count({ where: { riderId: { in: idsToRemove } } }),
      prisma.route.count({ where: { riderId: { in: idsToRemove } } }),
      prisma.reconDaily.count({ where: { riderId: { in: idsToRemove } } }),
      prisma.payout.count({ where: { riderId: { in: idsToRemove } } }),
      prisma.sosAlert.count({ where: { riderId: { in: idsToRemove } } }),
    ]);
  const usersToRemove = toRemove.filter((r) => r.userId).length;

  console.log(`\nRiders to remove: ${toRemove.length}`);
  console.log(`  Linked login (User) accounts to remove: ${usersToRemove}`);
  console.log(`  Job rows that will be unassigned (riderId -> null, NOT deleted): ${jobsToUnassign}`);
  console.log(`  JobOffer rows to delete (cascade): ${offersToRemove}`);
  console.log(`  RiderAssignment rows to delete (cascade): ${assignmentsToRemove}`);
  console.log(`  RiderLocation rows to delete (cascade): ${locationsToRemove}`);
  console.log(`  Route rows to delete (cascade): ${routesToRemove}`);
  console.log(`  ReconDaily rows to delete (cascade): ${reconToRemove}`);
  console.log(`  Payout rows to delete (cascade): ${payoutsToRemove}`);
  console.log(`  SosAlert rows to delete (cascade): ${sosToRemove}`);
  console.log(`\nWill be left completely unchanged: Customer, Zone, Setting rows, all ${before.staffUsers} non-rider User accounts, and every Job row's content (only riderId on the ${jobsToUnassign} above changes).`);

  if (!yes) {
    console.log("\nDRY RUN — no changes made. Re-run with --yes to actually delete these rows.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const rider of toRemove) {
      await tx.rider.delete({ where: { id: rider.id } });
      if (rider.userId) {
        await tx.user.delete({ where: { id: rider.userId } }).catch((err) => {
          // Already gone (shouldn't happen — userId came from this same row a
          // moment ago — but never leave the transaction half-applied silently).
          throw new Error(`Failed to remove login for rider ${rider.name} (${rider.phone}): ${String(err)}`);
        });
      }
    }
  });

  const after = await countAll();
  console.log("\n--- Done. Row counts before -> after ---");
  for (const [key, beforeVal] of Object.entries(before)) {
    console.log(`  ${key}: ${beforeVal} -> ${after[key]}`);
  }

  const problems = [];
  if (after.riders !== 1) problems.push(`expected exactly 1 rider left, found ${after.riders}`);
  if (after.customers !== before.customers) problems.push("Customer count changed");
  if (after.zones !== before.zones) problems.push("Zone count changed");
  if (after.settings !== before.settings) problems.push("Setting count changed");
  if (after.staffUsers !== before.staffUsers) problems.push("non-rider User count changed");
  if (after.jobs !== before.jobs) problems.push("Job count changed (jobs must only be unassigned, never deleted, by this script)");
  if (problems.length) {
    console.error("\nPOST-CHECK FAILED:\n  " + problems.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log("\nPost-check OK: exactly 1 rider remains; customers/zones/settings/staff-users/jobs all unchanged in count.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

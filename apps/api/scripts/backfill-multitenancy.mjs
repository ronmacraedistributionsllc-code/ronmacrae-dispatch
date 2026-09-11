#!/usr/bin/env node
/**
 * Stage 20 — multi-tenancy foundation, phase B (data backfill).
 *
 * Phase A already pushed the schema with every new `businessId` column
 * nullable (see schema.prisma) so the push itself was purely additive. This
 * script does the actual migration:
 *
 *   1. Creates the "Ronmacrae Distributions" Business row, copying its
 *      settings out of the old singleton `Setting("business")` blob.
 *   2. Backfills businessId onto every existing Zone/Customer/Job/JobOffer
 *      row — there is exactly one business today, so every row belongs to it.
 *   3. Creates a StaffMembership at Ronmacrae for every existing staff User
 *      (admin/dispatcher/accountant/viewer), mirroring their current
 *      User.role — nothing about their access changes.
 *   4. Creates an active RiderMembership at Ronmacrae for every existing
 *      Rider, and marks their platform status `approved` (they are real,
 *      already-vetted riders, not new open-network signups).
 *   5. Creates a dedicated platform-owner login, separate from any business's
 *      own admin — the platform owner oversees every business but isn't
 *      automatically a member/admin of any one of them.
 *
 * Safety: dry-run by default (prints exactly what it would do, changes
 * nothing, exits 0). Pass --yes to actually execute. Everything happens in
 * one Prisma transaction — either it all lands, or (on any error) none of it
 * does. Refuses to run --yes a second time once a Business already exists
 * (idempotency guard — this is a one-time migration, not a sync job).
 *
 * Usage (from apps/api, with DATABASE_URL pointing at the dev.db to migrate):
 *   node scripts/backfill-multitenancy.mjs                # dry run
 *   node scripts/backfill-multitenancy.mjs --yes           # actually migrate
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";

const args = process.argv.slice(2);
const yes = args.includes("--yes");

const OWNER_EMAIL = "owner@ronmacrae.example";
const OWNER_NAME = "Platform Owner";
// Dev-only, matches the project's existing plain "adjectivepassword" demo
// convention (admin1234, dispatch1234, ...) — never used outside DEV_DB=1.
const OWNER_PASSWORD = "owner12345";

// Mirrors src/lib/password.ts's hashPassword exactly (this script runs via
// plain `node`, not `tsx`, so it can't import the TS module directly) —
// format "s1:saltHex:hashHex", scrypt N=16384 r=8 p=1, 64-byte key.
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1:${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const existingBusiness = await prisma.business.findFirst();
    if (existingBusiness) {
      console.log(`[backfill] a Business already exists (${existingBusiness.name}, ${existingBusiness.id}) — refusing to run again. This is a one-time migration.`);
      process.exit(existingBusiness ? 0 : 1);
    }

    const [businessSetting, users, riders, zones, customers, jobs, offers] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "business" } }),
      prisma.user.findMany(),
      prisma.rider.findMany(),
      prisma.zone.findMany(),
      prisma.customer.findMany(),
      prisma.job.findMany({ select: { id: true } }),
      prisma.jobOffer.findMany({ select: { id: true, jobId: true } }),
    ]);
    const biz = businessSetting?.value ?? {};
    const staffUsers = users.filter((u) => u.role !== "rider");
    const ownerExists = users.some((u) => u.email === OWNER_EMAIL);

    console.log("[backfill] plan:");
    console.log(`  - create Business "Ronmacrae Distributions" from Setting("business"): ${JSON.stringify(biz)}`);
    console.log(`  - backfill businessId on ${zones.length} zones, ${customers.length} customers, ${jobs.length} jobs, ${offers.length} offers`);
    console.log(`  - create ${staffUsers.length} StaffMembership rows (one per non-rider User, mirroring their current role)`);
    console.log(`  - create ${riders.length} RiderMembership rows (active, platform-approved)`);
    console.log(`  - ${ownerExists ? "platform owner login already exists, skip" : `create platform owner login ${OWNER_EMAIL} / ${OWNER_PASSWORD}`}`);

    if (!yes) {
      console.log("\n[backfill] dry run only — pass --yes to actually migrate.");
      return;
    }

    await prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name: biz.businessName ?? "Ronmacrae Distributions",
          slug: "ronmacrae",
          dispatchPhone: biz.dispatchPhone || null,
          dispatchWhatsApp: biz.dispatchWhatsApp || null,
          operationalCurrency: biz.operationalCurrency ?? "JMD",
          usdToJmdRate: biz.usdToJmdRate ?? null,
          defaultZoneId: null, // set after zones are backfilled, below
          pinLength: biz.pinLength ?? 4,
          trackingLinkTtlHours: biz.trackingLinkTtlHours ?? 72,
          nativeAppRecommended: biz.nativeAppRecommended ?? true,
        },
      });

      await tx.zone.updateMany({ data: { businessId: business.id } });
      await tx.customer.updateMany({ data: { businessId: business.id } });
      await tx.job.updateMany({ data: { businessId: business.id } });
      await tx.jobOffer.updateMany({ data: { businessId: business.id } });
      if (biz.defaultZoneId) {
        await tx.business.update({ where: { id: business.id }, data: { defaultZoneId: biz.defaultZoneId } });
      }

      for (const u of staffUsers) {
        await tx.staffMembership.create({ data: { userId: u.id, businessId: business.id, role: u.role, active: u.active } });
      }

      for (const r of riders) {
        await tx.rider.update({ where: { id: r.id }, data: { platformStatus: "approved" } });
        await tx.riderMembership.create({
          data: { riderId: r.id, businessId: business.id, status: "active", approvedAt: new Date() },
        });
      }

      if (!ownerExists) {
        await tx.user.create({
          data: {
            email: OWNER_EMAIL,
            name: OWNER_NAME,
            passwordHash: hashPassword(OWNER_PASSWORD),
            role: "admin", // legacy field, unused for a platform-role user; kept non-null to satisfy the schema default's intent
            platformRole: "owner",
          },
        });
      }

      return business;
    });

    console.log("\n[backfill] done.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});

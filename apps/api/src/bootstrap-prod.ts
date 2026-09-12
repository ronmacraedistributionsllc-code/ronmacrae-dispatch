/**
 * One-time production bootstrap (idempotent, safe to re-run).
 *
 * Unlike seed.ts (dev/demo only — fake customers, a demo rider, demo zones),
 * this creates ONLY what a brand-new, otherwise-empty production database
 * genuinely needs to start operating: the real business record (matching
 * the slug the public order form looks up — see order.ts's
 * DEFAULT_PUBLIC_BUSINESS_SLUG) and exactly one real admin login. No demo
 * customers, no demo riders, no demo zones — those are real business
 * configuration the owner adds through the app itself.
 *
 * Re-running this is always safe: an existing admin's password is never
 * touched (a fresh password is generated and hashed only the first time
 * the user is created), and the business/staff-membership upserts are
 * idempotent no-ops once they already match.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/log.js";
import { getPrisma, type PrismaClient } from "./prisma.js";
import { hashPassword } from "./lib/password.js";
import { randomBytes } from "node:crypto";

const BUSINESS_SLUG = "ronmacrae";
export const ADMIN_EMAIL = "owner@ronmacraedistributions.com";

export function randomPassword(): string {
  return randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
}

export interface BootstrapResult {
  businessId: string;
  userId: string;
  /** The freshly generated password, only when a new admin user was just
   *  created — null when the admin already existed (its password is never
   *  touched, so there is nothing new to show). */
  generatedPassword: string | null;
}

/** Creates the business (if missing) and exactly one admin login (if
 *  missing) — an already-existing admin's password is never regenerated,
 *  reset, or even read. Explicit branching on purpose: a `create` object
 *  built once and handed to `upsert` would call `hashPassword(...)`
 *  eagerly, before Prisma even knows whether it's doing a create or an
 *  update — the exact bug this replaces (hashing a null password on the
 *  update path). */
export async function bootstrapProduction(prisma: PrismaClient, cfg: {
  operationalCurrency: string;
  usdToJmdRate: number;
  pinLength: number;
  trackingLinkTtlHours: number;
}): Promise<BootstrapResult> {
  const business = await prisma.business.upsert({
    where: { slug: BUSINESS_SLUG },
    create: {
      name: "Ronmacrae Distributions",
      slug: BUSINESS_SLUG,
      dispatchPhone: "+8765550100",
      dispatchWhatsApp: "+8765550100",
      operationalCurrency: cfg.operationalCurrency,
      usdToJmdRate: cfg.usdToJmdRate,
      pinLength: cfg.pinLength,
      trackingLinkTtlHours: cfg.trackingLinkTtlHours,
      nativeAppRecommended: true,
    },
    update: {},
  });

  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

  let userId: string;
  let generatedPassword: string | null = null;

  if (existing) {
    // Admin already exists: use it as-is. Never hash, reset, or touch its
    // password — only its active flag / staff role are kept in sync below.
    userId = existing.id;
    await prisma.user.update({ where: { id: existing.id }, data: { active: true } });
  } else {
    generatedPassword = randomPassword();
    const created = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: "Owner",
        role: "admin",
        active: true,
        passwordHash: hashPassword(generatedPassword),
      },
    });
    userId = created.id;
  }

  await prisma.staffMembership.upsert({
    where: { userId_businessId: { userId, businessId: business.id } },
    create: { userId, businessId: business.id, role: "admin", active: true },
    update: { active: true },
  });

  return { businessId: business.id, userId, generatedPassword };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, "bootstrap-prod");
  const prisma = getPrisma(config);
  try {
    await prisma.$connect();

    const result = await bootstrapProduction(prisma, {
      operationalCurrency: config.OPERATIONAL_CURRENCY,
      usdToJmdRate: config.USD_TO_JMD_RATE,
      pinLength: config.PIN_LENGTH,
      trackingLinkTtlHours: config.TRACKING_LINK_TTL_HOURS,
    });
    console.log(`business: ${BUSINESS_SLUG} [${result.businessId}]`);

    if (result.generatedPassword) {
      console.log("=".repeat(60));
      console.log("ADMIN LOGIN CREATED — copy this now, it will not be shown again:");
      console.log(`  email:    ${ADMIN_EMAIL}`);
      console.log(`  password: ${result.generatedPassword}`);
      console.log("Change the password after your first login.");
      console.log("=".repeat(60));
    } else {
      console.log(`admin user ${ADMIN_EMAIL} already existed — password unchanged, not shown.`);
    }

    log.info({}, "bootstrap-prod complete");
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly (so tests can import bootstrapProduction
// without triggering a real main() run).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("bootstrap-prod failed:", err);
    process.exit(1);
  });
}

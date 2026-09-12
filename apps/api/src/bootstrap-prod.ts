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
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/log.js";
import { getPrisma } from "./prisma.js";
import { hashPassword } from "./lib/password.js";
import { randomBytes } from "node:crypto";

const BUSINESS_SLUG = "ronmacrae";
const ADMIN_EMAIL = "owner@ronmacraedistributions.com";

function randomPassword(): string {
  return randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, "bootstrap-prod");
  const prisma = getPrisma(config);
  await prisma.$connect();

  const business = await prisma.business.upsert({
    where: { slug: BUSINESS_SLUG },
    create: {
      name: "Ronmacrae Distributions",
      slug: BUSINESS_SLUG,
      dispatchPhone: "+8765550100",
      dispatchWhatsApp: "+8765550100",
      operationalCurrency: config.OPERATIONAL_CURRENCY,
      usdToJmdRate: config.USD_TO_JMD_RATE,
      pinLength: config.PIN_LENGTH,
      trackingLinkTtlHours: config.TRACKING_LINK_TTL_HOURS,
      nativeAppRecommended: true,
    },
    update: {},
  });
  console.log(`business: ${business.name} (${business.slug}) [${business.id}]`);

  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  const password = existing ? null : randomPassword();
  const user = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      email: ADMIN_EMAIL,
      name: "Owner",
      role: "admin",
      active: true,
      passwordHash: hashPassword(password!),
    },
    update: {},
  });
  await prisma.staffMembership.upsert({
    where: { userId_businessId: { userId: user.id, businessId: business.id } },
    create: { userId: user.id, businessId: business.id, role: "admin", active: true },
    update: { active: true },
  });

  if (password) {
    console.log("=".repeat(60));
    console.log("ADMIN LOGIN CREATED — copy this now, it will not be shown again:");
    console.log(`  email:    ${ADMIN_EMAIL}`);
    console.log(`  password: ${password}`);
    console.log("Change the password after your first login.");
    console.log("=".repeat(60));
  } else {
    console.log(`admin user ${ADMIN_EMAIL} already existed — password unchanged, not shown.`);
  }

  await prisma.$disconnect();
  log.info({}, "bootstrap-prod complete");
}

main().catch((err) => {
  console.error("bootstrap-prod failed:", err);
  process.exit(1);
});

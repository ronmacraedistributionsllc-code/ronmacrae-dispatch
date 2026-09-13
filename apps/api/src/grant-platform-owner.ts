/**
 * One-time, idempotent grant of `platformRole: "owner"` to an existing
 * account — needed because bootstrap-prod.ts never set this (the real
 * account owner's admin login has always had ordinary `role: "admin"`
 * with a StaffMembership, never platform-wide authority). Without this,
 * ctx.requireOwner (owner.ts, platform-admin.ts) refuses everyone,
 * including the account owner themselves.
 *
 * Set GRANT_OWNER_EMAIL to the email to grant. Safe to re-run: it only
 * ever sets one field on one existing row, never creates or deletes
 * anything, never touches a password.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/log.js";
import { getPrisma } from "./prisma.js";

async function main(): Promise<void> {
  const email = process.env.GRANT_OWNER_EMAIL;
  if (!email) {
    console.error("Set GRANT_OWNER_EMAIL to the account's email before running this.");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, "grant-platform-owner");
  const prisma = getPrisma(config);
  try {
    await prisma.$connect();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      console.error(`No account found with email ${email} — nothing changed.`);
      process.exitCode = 1;
      return;
    }
    if (existing.platformRole === "owner") {
      console.log(`${email} already has platformRole: owner — nothing to do.`);
      return;
    }
    await prisma.user.update({ where: { email }, data: { platformRole: "owner" } });
    console.log(`Granted platformRole: owner to ${email}.`);
    log.info({}, "grant-platform-owner complete");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("grant-platform-owner failed:", err);
  process.exit(1);
});

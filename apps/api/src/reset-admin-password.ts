/**
 * One-time, explicit admin-password reset.
 *
 * Unlike bootstrap-prod.ts (which deliberately never touches an existing
 * admin's password), this ALWAYS sets a fresh one for the known admin
 * login — for exactly one situation: the password from a previous
 * bootstrap run was never actually seen/copied, so there is no way to log
 * in. Only ever run this intentionally; it is not meant to be left as a
 * standing Start Command.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/log.js";
import { getPrisma } from "./prisma.js";
import { hashPassword } from "./lib/password.js";
import { ADMIN_EMAIL, randomPassword } from "./bootstrap-prod.js";

/** Set RESET_ADMIN_PASSWORD to force a specific password instead of a
 *  randomly generated one — useful when diagnosing whether a password
 *  actually reached the login check correctly, without relying on a
 *  human to transcribe a random string out of a log viewer. */
function choosePassword(): string {
  return process.env.RESET_ADMIN_PASSWORD || randomPassword();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, "reset-admin-password");
  const prisma = getPrisma(config);
  try {
    await prisma.$connect();

    const user = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (!user) {
      console.error(`No user found with email ${ADMIN_EMAIL} — run bootstrap-prod.ts first.`);
      process.exitCode = 1;
      return;
    }

    const password = choosePassword();
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } });

    console.log("=".repeat(60));
    console.log("ADMIN PASSWORD RESET — copy this now, it will not be shown again:");
    console.log(`  email:    ${ADMIN_EMAIL}`);
    console.log(`  password: ${password}`);
    console.log("=".repeat(60));

    log.info({}, "reset-admin-password complete");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("reset-admin-password failed:", err);
  process.exit(1);
});

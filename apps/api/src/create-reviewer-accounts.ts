/**
 * Creates the logins an app-store reviewer needs, inside a SEPARATE demo
 * business — never the real one, so a reviewer can't see real customers,
 * phone numbers, or addresses.
 *
 *   npm run reviewer-accounts --workspace @ronmacrae/api -- --i-understand-this-writes-data
 *
 * Safety:
 *  - Refuses to run without --i-understand-this-writes-data, and prints the
 *    database it's about to write to (host/file only — never credentials).
 *  - Idempotent and additive: re-running never changes an existing
 *    account's password (pass --reset-passwords to rotate them) and never
 *    deletes anything.
 *  - Passwords are generated here, never hard-coded, and printed ONCE to
 *    stdout for whoever runs it to copy into the store consoles.
 *  - The reviewer logins use the reserved-looking domain app-review.example,
 *    so no email is ever sent to a real mailbox.
 *
 * The OWNER runs this against production; it was only ever run against the
 * local dev database while building it.
 */
import { randomBytes } from "node:crypto";
import { loadConfig, effectiveDatabaseUrl } from "./config.js";
import { getPrisma } from "./prisma.js";
import { hashPassword } from "./lib/password.js";
import { nextJobNumber } from "./modules/jobs/repository.js";

const DEMO_SLUG = "app-review-demo";
const FLAG = "--i-understand-this-writes-data";

const ACCOUNTS = {
  dispatcher: { email: "reviewer.dispatcher@app-review.example", name: "Review Dispatcher" },
  merchant: { email: "reviewer.merchant@app-review.example", name: "Review Merchant" },
  // Signs in by email like the others. Rider.phone is a required, unique
  // column, so it gets a placeholder (a valid-format Jamaican number that is
  // only ever shown in the demo business; the user's own phone stays empty).
  courier: { email: "reviewer.courier@app-review.example", name: "Review Courier", riderPhone: "+18763009901" },
} as const;

function password(): string {
  // 16 chars, unambiguous alphabet, easy to type into a console form.
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join("");
}

function describeTarget(url: string): string {
  if (!url) return "(none)";
  if (url.startsWith("file:")) return `SQLite file ${url.replace(/^file:/, "")}`;
  try {
    const u = new URL(url);
    return `${u.protocol.replace(":", "")} database on ${u.host}${u.pathname}`; // no username/password
  } catch {
    return "(unparseable database URL)";
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const target = describeTarget(effectiveDatabaseUrl(config, process.cwd()));
  console.log(`Target: ${target}`);
  if (!process.argv.includes(FLAG)) {
    console.error(`\nRefusing to write. Re-run with ${FLAG} once the target above is the one you mean.`);
    process.exitCode = 1;
    return;
  }
  const reset = process.argv.includes("--reset-passwords");
  const prisma = getPrisma(config);
  const issued: { label: string; login: string; password: string }[] = [];

  try {
    await prisma.$connect();

    const business = await prisma.business.upsert({
      where: { slug: DEMO_SLUG },
      create: { name: "App Review Demo (not a real business)", slug: DEMO_SLUG },
      update: {},
    });

    /** Creates the user if missing (issuing a password), else leaves it alone unless --reset-passwords. */
    async function ensureUser(label: string, key: { email: string } | { phone: string }, name: string, role: "admin" | "dispatcher" | "rider" | "viewer") {
      const existing = await prisma.user.findFirst({ where: "email" in key ? { email: key.email } : { phone: key.phone } });
      const login = "email" in key ? key.email : key.phone;
      if (existing && !reset) {
        console.log(`  exists  ${label}: ${login} (password unchanged)`);
        return existing;
      }
      const pw = password();
      issued.push({ label, login, password: pw });
      const data = { ...key, name, role, active: true, deletedAt: null, passwordHash: hashPassword(pw), emailVerifiedAt: new Date() };
      return existing
        ? prisma.user.update({ where: { id: existing.id }, data })
        : prisma.user.create({ data });
    }

    const dispatcher = await ensureUser("dispatcher", { email: ACCOUNTS.dispatcher.email }, ACCOUNTS.dispatcher.name, "dispatcher");
    await prisma.staffMembership.upsert({
      where: { userId_businessId: { userId: dispatcher.id, businessId: business.id } },
      create: { userId: dispatcher.id, businessId: business.id, role: "dispatcher", active: true },
      update: { role: "dispatcher", active: true },
    });

    const merchantUser = await ensureUser("merchant", { email: ACCOUNTS.merchant.email }, ACCOUNTS.merchant.name, "viewer");
    const merchant = await prisma.merchant.upsert({
      where: { businessId_slug: { businessId: business.id, slug: "demo-store" } },
      create: { businessId: business.id, name: "Demo Store", slug: "demo-store", active: true, pickupAddressText: "1 Demo Street, Kingston" },
      update: { active: true },
    });
    await prisma.merchantStaff.upsert({
      where: { userId_merchantId: { userId: merchantUser.id, merchantId: merchant.id } },
      create: { userId: merchantUser.id, merchantId: merchant.id, active: true },
      update: { active: true },
    });

    const courierUser = await ensureUser("courier", { email: ACCOUNTS.courier.email }, ACCOUNTS.courier.name, "rider");
    const rider = await prisma.rider.upsert({
      where: { phone: ACCOUNTS.courier.riderPhone },
      create: { userId: courierUser.id, name: ACCOUNTS.courier.name, phone: ACCOUNTS.courier.riderPhone, vehicle: "motorcycle", status: "available", active: true, platformStatus: "approved", verified: true },
      update: { userId: courierUser.id, active: true, platformStatus: "approved", verified: true },
    });
    await prisma.riderMembership.upsert({
      where: { riderId_businessId: { riderId: rider.id, businessId: business.id } },
      create: { riderId: rider.id, businessId: business.id, status: "active", approvedAt: new Date() },
      update: { status: "active" },
    });

    // Two demo orders so the reviewer's screens aren't empty. Only if the demo business has none yet.
    if ((await prisma.job.count({ where: { businessId: business.id } })) === 0) {
      const customer = await prisma.customer.create({ data: { businessId: business.id, name: "Demo Customer", phone: "+18765559900" } });
      for (const [i, status] of (["new", "assigned"] as const).entries()) {
        await prisma.job.create({
          data: {
            businessId: business.id,
            merchantId: merchant.id,
            customerId: customer.id,
            jobNumber: await nextJobNumber({ prisma } as Parameters<typeof nextJobNumber>[0], business.id),
            type: "delivery",
            status,
            riderId: status === "assigned" ? rider.id : null,
            addressText: i === 0 ? "12 Demo Avenue, Half Way Tree" : "3 Sample Road, Portmore",
            pickupAddressText: "1 Demo Street, Kingston",
            itemSummary: i === 0 ? "Demo order — new, waiting for a courier" : "Demo order — assigned to the demo courier",
            paymentMethod: "cod",
            fare: 150000,
            fee: 35000,
            subtotal: 185000,
            amountExpected: 185000,
            pin: "1234",
          },
        });
      }
      console.log("  created two demo orders");
    }

    console.log(`\nDemo business: ${business.name} (${DEMO_SLUG})`);
    if (issued.length === 0) {
      console.log("No new passwords issued (accounts already existed). Use --reset-passwords to rotate them.");
    } else {
      console.log("\nCopy these now — they are NOT stored anywhere readable and won't be shown again:\n");
      for (const a of issued) console.log(`  ${a.label.padEnd(11)} ${a.login.padEnd(42)} ${a.password}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("create-reviewer-accounts failed:", err);
  process.exit(1);
});

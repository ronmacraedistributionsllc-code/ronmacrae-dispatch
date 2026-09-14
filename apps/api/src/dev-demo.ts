/**
 * Development demo data (idempotent) — for trying the merchant courier-roster
 * and platform-admin rider-assignment features end to end. Safe to re-run:
 * every write is an upsert on a unique key; it never deletes anything and
 * never touches an existing password.
 *
 * Run after `npm run seed`:
 *   npx tsx src/dev-demo.ts
 *
 * What it sets up (on the seeded "ronmacrae" business):
 *   - grants platformRole "owner" to admin@ronmacrae.example
 *   - Merchant A "VBR Basics"  -> merchant-a@ronmacrae.example / merchantA1234
 *   - Merchant B "Kensington Store" -> merchant-b@ronmacrae.example / merchantB1234
 *   - Rider B "Tashia Rider" (+8765550002) alongside the seeded Rider A
 *   - pre-attaches Rider A to both merchants, leaves Rider B unattached
 *     (so you can test "add courier" + see an unassigned courier in admin)
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/log.js";
import { getPrisma } from "./prisma.js";
import { hashPassword } from "./lib/password.js";

const BUSINESS_SLUG = "ronmacrae";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, "dev-demo");
  const prisma = getPrisma(config);
  await prisma.$connect();

  console.log("Setting up demo data (idempotent):");

  const business = await prisma.business.findUnique({ where: { slug: BUSINESS_SLUG } });
  if (!business) {
    console.error(`No business with slug "${BUSINESS_SLUG}" found — run "npm run seed" first.`);
    process.exitCode = 1;
    return;
  }
  const businessId = business.id;

  // Platform owner (so Platform Admin -> Couriers works).
  const ownerEmail = "admin@ronmacrae.example";
  const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (!owner) {
    console.error(`No account found for ${ownerEmail} — run "npm run seed" first.`);
    process.exitCode = 1;
    return;
  }
  if (owner.platformRole !== "owner") {
    await prisma.user.update({ where: { email: ownerEmail }, data: { platformRole: "owner" } });
    console.log(`  owner    granted platformRole to ${ownerEmail}`);
  } else {
    console.log(`  owner    ${ownerEmail} already owner`);
  }

  async function ensureMerchant(name: string, slug: string, email: string, password: string) {
    const merchant = await prisma.merchant.upsert({
      where: { businessId_slug: { businessId: businessId, slug } },
      create: { businessId: businessId, name, slug, phone: "+8765550000", email, active: true },
      update: { name, active: true },
    });
    const user = await prisma.user.upsert({
      where: { email },
      create: { email, name: `${name} Owner`, passwordHash: hashPassword(password), role: "viewer", emailVerifiedAt: new Date(), active: true },
      update: { active: true, emailVerifiedAt: new Date() },
    });
    await prisma.merchantStaff.upsert({
      where: { userId_merchantId: { userId: user.id, merchantId: merchant.id } },
      create: { userId: user.id, merchantId: merchant.id, active: true },
      update: { active: true },
    });
    console.log(`  merchant ${name} -> ${email} / ${password}`);
    return merchant;
  }

  const merchantA = await ensureMerchant("VBR Basics", "vbr-basics", "merchant-a@ronmacrae.example", "merchantA1234");
  const merchantB = await ensureMerchant("Kensington Store", "kensington-store", "merchant-b@ronmacrae.example", "merchantB1234");

  async function ensureRider(name: string, phone: string, plate: string) {
    const user = await prisma.user.upsert({
      where: { phone },
      create: { phone, name, role: "rider", active: true, passwordHash: hashPassword("rider1234") },
      update: { name, role: "rider", active: true },
    });
    const rider = await prisma.rider.upsert({
      where: { phone },
      create: { userId: user.id, name, phone, vehicle: "motorcycle", plate, status: "available", dailyCapacity: 15, active: true, platformStatus: "approved" },
      update: { userId: user.id, name, active: true, platformStatus: "approved" },
    });
    await prisma.riderMembership.upsert({
      where: { riderId_businessId: { riderId: rider.id, businessId: businessId } },
      create: { riderId: rider.id, businessId: businessId, status: "active", approvedAt: new Date() },
      update: { status: "active", approvedAt: new Date() },
    });
    console.log(`  rider    ${name} ${phone} (id ${rider.id})`);
    return rider;
  }

  const riderA = await ensureRider("Kei Bearer", "+8765550001", "JMD 1234");
  const riderB = await ensureRider("Tashia Rider", "+8765550002", "JMD 5678");

  // Pre-attach Rider A to both merchants (demonstrates many-to-many);
  // leave Rider B unattached so "add courier" and "unassigned courier" can be tried.
  for (const [merchant, rider] of [
    [merchantA, riderA],
    [merchantB, riderA],
  ] as const) {
    const rel = await prisma.merchantRider.findUnique({ where: { merchantId_riderId: { merchantId: merchant.id, riderId: rider.id } } });
    if (!rel) {
      await prisma.merchantRider.create({ data: { merchantId: merchant.id, riderId: rider.id, status: "active", approvedAt: new Date() } });
      console.log(`  attach   ${rider.name} -> ${merchant.name}`);
    }
  }
  // Rider B is deliberately left unattached (so "add courier" and the
  // admin "unassigned courier" view can be exercised against a real rider).
  console.log(`  note     ${riderB.name} is left unattached for testing "add courier"`);

  await prisma.$disconnect();
  log.info({}, "dev-demo complete");
  console.log("\nDemo accounts ready:");
  console.log("  Platform Admin:  admin@ronmacrae.example / admin1234  (open /platform-admin)");
  console.log("  Merchant A:      merchant-a@ronmacrae.example / merchantA1234");
  console.log("  Merchant B:      merchant-b@ronmacrae.example / merchantB1234");
}

main().catch((err) => {
  console.error("dev-demo failed:", err);
  process.exit(1);
});

/**
 * Development seed (idempotent).
 * Creates the demo business, demo staff + a rider (as members of it),
 * Kingston-area zones with fare rules, a couple of customers, and the
 * business's own settings — all scoped to that one seeded business.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/log.js";
import { getPrisma } from "./prisma.js";
import { hashPassword } from "./lib/password.js";
import { minorOf } from "@ronmacrae/money";
import type { ZoneGeometry } from "@ronmacrae/contracts";
import type { PrismaClient } from "@prisma/client";

const BUSINESS_SLUG = "ronmacrae";

function square(lat: number, lng: number, dLat: number, dLng: number): ZoneGeometry {
  const ring: [number, number][] = [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
    [lng - dLng, lat - dLat],
  ];
  return { type: "Polygon", coordinates: [ring] };
}

interface SeedUser {
  email: string;
  name: string;
  role: "admin" | "dispatcher" | "accountant" | "viewer";
  password: string;
}

async function seedBusiness(prisma: PrismaClient, currency: string, usdToJmdRate: number, pinLength: number, trackingLinkTtlHours: number): Promise<string> {
  const business = await prisma.business.upsert({
    where: { slug: BUSINESS_SLUG },
    create: {
      name: "Ronmacrae Distributions",
      slug: BUSINESS_SLUG,
      dispatchPhone: "+8765550100",
      dispatchWhatsApp: "+8765550100",
      operationalCurrency: currency,
      usdToJmdRate,
      pinLength,
      trackingLinkTtlHours,
      nativeAppRecommended: true,
    },
    update: {},
  });
  console.log(`  business ${business.name} (${business.slug})`);
  return business.id;
}

async function seedStaff(prisma: PrismaClient, businessId: string, users: SeedUser[]): Promise<void> {
  for (const u of users) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email,
        name: u.name,
        role: u.role,
        active: true,
        passwordHash: hashPassword(u.password),
      },
      update: { name: u.name, role: u.role, active: true },
    });
    await prisma.staffMembership.upsert({
      where: { userId_businessId: { userId: user.id, businessId } },
      create: { userId: user.id, businessId, role: u.role, active: true },
      update: { role: u.role, active: true },
    });
    console.log(`  staff   ${u.role.padEnd(11)} ${u.email} / ${u.password}`);
  }
}

async function seedRider(prisma: PrismaClient, businessId: string): Promise<string> {
  const user = await prisma.user.upsert({
    where: { phone: "+8765550001" },
    create: {
      phone: "+8765550001",
      name: "Kei Bearer",
      role: "rider",
      active: true,
      passwordHash: hashPassword("rider1234"),
    },
    update: { name: "Kei Bearer", role: "rider", active: true },
  });
  const rider = await prisma.rider.upsert({
    where: { phone: "+8765550001" },
    create: {
      userId: user.id,
      name: "Kei Bearer",
      phone: "+8765550001",
      vehicle: "motorcycle",
      plate: "JMD 1234",
      status: "available",
      dailyCapacity: 15,
      active: true,
      platformStatus: "approved",
    },
    update: { userId: user.id, name: user.name, active: true, platformStatus: "approved" },
  });
  await prisma.riderMembership.upsert({
    where: { riderId_businessId: { riderId: rider.id, businessId } },
    create: { riderId: rider.id, businessId, status: "active", approvedAt: new Date() },
    update: { status: "active", approvedAt: new Date() },
  });
  console.log(`  rider   ${rider.name} ${rider.phone} / rider1234 (id ${rider.id})`);
  return rider.id;
}

async function seedZones(prisma: PrismaClient, businessId: string): Promise<Record<string, string>> {
  const zones = [
    { name: "Kingston Central", parish: "Kingston", slug: "kingston-central", lat: 17.9714, lng: -76.7932, base: 300, perKm: 55 },
    { name: "Portmore", parish: "St. Catherine", slug: "portmore", lat: 17.9266, lng: -76.803, base: 250, perKm: 50 },
    { name: "Spanish Town", parish: "St. Catherine", slug: "spanish-town", lat: 17.9986, lng: -76.8393, base: 400, perKm: 65 },
  ];
  const ids: Record<string, string> = {};
  for (const z of zones) {
    const row = await prisma.zone.upsert({
      where: { businessId_slug: { businessId, slug: z.slug } },
      create: {
        businessId,
        name: z.name,
        slug: z.slug,
        parish: z.parish,
        geometry: square(z.lat, z.lng, 0.018, 0.024) as object,
        baseFee: minorOf(z.base, "JMD"),
        feeCurrency: "JMD",
        perKmFee: minorOf(z.perKm, "JMD"),
        active: true,
      },
      update: { active: true },
    });
    ids[z.slug] = row.id;
    console.log(`  zone    ${z.name} (${z.slug})`);
  }
  return ids;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL, "seed");
  const prisma = getPrisma(config);
  await prisma.$connect();

  console.log("Seeding demo data (idempotent):");
  const businessId = await seedBusiness(prisma, config.OPERATIONAL_CURRENCY, config.USD_TO_JMD_RATE, config.PIN_LENGTH, config.TRACKING_LINK_TTL_HOURS);
  await seedStaff(prisma, businessId, [
    { email: "admin@ronmacrae.example", name: "Ada Admin", role: "admin", password: "admin1234" },
    { email: "dispatcher@ronmacrae.example", name: "Dwayne Dispatch", role: "dispatcher", password: "dispatch1234" },
    { email: "accountant@ronmacrae.example", name: "Anita Accounts", role: "accountant", password: "account1234" },
    { email: "viewer@ronmacrae.example", name: "Vera Viewer", role: "viewer", password: "viewer1234" },
  ]);
  await seedRider(prisma, businessId);

  const zoneIds = await seedZones(prisma, businessId);
  await prisma.fareRule.upsert({
    where: { fromZoneId_toZoneId: { fromZoneId: zoneIds["kingston-central"]!, toZoneId: zoneIds["portmore"]! } },
    create: {
      fromZoneId: zoneIds["kingston-central"]!,
      toZoneId: zoneIds["portmore"]!,
      fee: minorOf(350, "JMD"),
      minFee: minorOf(250, "JMD"),
      currency: "JMD",
      note: "Downtown to Portmore flat",
    },
    update: { fee: minorOf(350, "JMD") },
  });
  console.log("  fare    kingston-central -> portmore J$350");

  const customers = [
    { name: "Shelly Smith", phone: "+8765551234", email: "shelly@example.com", address: "42 Constant Spring Rd, Constant Spring", lat: 17.995, lng: -76.78 },
    { name: "Marcus Brown", phone: "+8765555678", email: null, address: "1 Hope Ave, Portmore", lat: 17.927, lng: -76.805 },
  ];
  for (const c of customers) {
    await prisma.customer.upsert({
      where: { businessId_phone: { businessId, phone: c.phone } },
      create: {
        businessId,
        name: c.name,
        phone: c.phone,
        email: c.email,
        addressText: c.address,
        point: { lat: c.lat, lng: c.lng } as object,
      },
      update: { name: c.name },
    });
    console.log(`  customer ${c.name} ${c.phone}`);
  }

  await prisma.business.update({ where: { id: businessId }, data: { defaultZoneId: zoneIds["kingston-central"] ?? null } });

  await prisma.$disconnect();
  log.info({}, "seed complete");
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});

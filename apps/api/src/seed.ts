/**
 * Development seed (idempotent).
 * Creates demo staff + a rider, Kingston-area zones with fare rules,
 * a couple of customers and the business settings blob.
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./lib/log.js";
import { getPrisma } from "./prisma.js";
import { hashPassword } from "./lib/password.js";
import { minorOf } from "@ronmacrae/money";
import { BusinessSettings } from "@ronmacrae/contracts";
import type { ZoneGeometry } from "@ronmacrae/contracts";
import type { PrismaClient } from "@prisma/client";

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

async function seedStaff(prisma: PrismaClient, users: SeedUser[]): Promise<void> {
  for (const u of users) {
    await prisma.user.upsert({
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
    console.log(`  staff   ${u.role.padEnd(11)} ${u.email} / ${u.password}`);
  }
}

async function seedRider(prisma: PrismaClient): Promise<string> {
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
    },
    update: { userId: user.id, name: user.name, active: true },
  });
  console.log(`  rider   ${rider.name} ${rider.phone} / rider1234 (id ${rider.id})`);
  return rider.id;
}

async function seedZones(prisma: PrismaClient): Promise<Record<string, string>> {
  const zones = [
    { name: "Kingston Central", parish: "Kingston", slug: "kingston-central", lat: 17.9714, lng: -76.7932, base: 300, perKm: 55 },
    { name: "Portmore", parish: "St. Catherine", slug: "portmore", lat: 17.9266, lng: -76.803, base: 250, perKm: 50 },
    { name: "Spanish Town", parish: "St. Catherine", slug: "spanish-town", lat: 17.9986, lng: -76.8393, base: 400, perKm: 65 },
  ];
  const ids: Record<string, string> = {};
  for (const z of zones) {
    const row = await prisma.zone.upsert({
      where: { slug: z.slug },
      create: {
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
  await seedStaff(prisma, [
    { email: "admin@ronmacrae.example", name: "Ada Admin", role: "admin", password: "admin1234" },
    { email: "dispatcher@ronmacrae.example", name: "Dwayne Dispatch", role: "dispatcher", password: "dispatch1234" },
    { email: "accountant@ronmacrae.example", name: "Anita Accounts", role: "accountant", password: "account1234" },
    { email: "viewer@ronmacrae.example", name: "Vera Viewer", role: "viewer", password: "viewer1234" },
  ]);
  await seedRider(prisma);

  const zoneIds = await seedZones(prisma);
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
      where: { phone: c.phone },
      create: {
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

  const settings: BusinessSettings = {
    businessName: "Ronmacrae Distributions",
    dispatchPhone: "+8765550100",
    dispatchWhatsApp: "+8765550100",
    operationalCurrency: config.OPERATIONAL_CURRENCY,
    usdToJmdRate: config.USD_TO_JMD_RATE,
    defaultZoneId: zoneIds["kingston-central"] ?? null,
    pinLength: config.PIN_LENGTH,
    trackingLinkTtlHours: config.TRACKING_LINK_TTL_HOURS,
    nativeAppRecommended: true,
  };
  await prisma.setting.upsert({
    where: { key: "business" },
    create: { key: "business", value: settings as unknown as object },
    update: { value: settings as unknown as object },
  });
  console.log("  settings business");

  await prisma.$disconnect();
  log.info({}, "seed complete");
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});

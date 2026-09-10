import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FareEngine, QuoteBody } from "../src/modules/quotes.js";
import { ZonesService } from "../src/modules/zones.js";
import type { AppCtx } from "../src/ctx.js";
import type { PrismaClient } from "@prisma/client";
import type { GeoPoint } from "@ronmacrae/contracts";

/** square that covers all of Jamaica, so detect() resolves any in-island point */
const JAMAICA = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-78.6, 17.5],
      [-76.0, 17.5],
      [-76.0, 18.6],
      [-78.6, 18.6],
      [-78.6, 17.5],
    ],
  ],
};

interface ZoneRow {
  id: string;
  name: string;
  slug: string;
  parish: string | null;
  geometry: unknown;
  baseFee: number;
  feeCurrency: string;
  perKmFee: number | null;
  urgentSurchargeFee: number | null;
  active: boolean;
  version: number;
}

const row = (id: string, name: string, baseFee: number, perKmFee: number | null, urgentSurchargeFee: number | null = null): ZoneRow => ({
  id,
  name,
  slug: name.toLowerCase(),
  parish: null,
  geometry: JAMAICA,
  baseFee,
  feeCurrency: "JMD",
  perKmFee,
  urgentSurchargeFee,
  active: true,
  version: 1,
});

function makeApp(opts: { rule?: { fee: number; minFee: number | null } | null; zones?: ZoneRow[] }) {
  const prisma = {
    fareRule: { findFirst: vi.fn().mockResolvedValue(opts.rule ?? null) },
    zone: {
      findMany: vi.fn().mockResolvedValue(opts.zones ?? []),
      findUnique: vi.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve((opts.zones ?? []).find((z) => z.id === where.id) ?? null),
      ),
    },
  } as unknown as PrismaClient;

  const geo = {
    name: "fake",
    route: vi.fn().mockResolvedValue({
      mode: "car",
      provider: "fake",
      legs: [],
      totalDistanceM: 10_000,
      totalDurationS: 1200,
    }),
    matrix: vi.fn().mockResolvedValue([]),
    geocode: vi.fn().mockResolvedValue(null),
    reverseGeocode: vi.fn().mockResolvedValue(null),
  };

  const app = { config: { OPERATIONAL_CURRENCY: "JMD" }, geo, prisma } as unknown as AppCtx;
  return { app, geo };
}

const KINGSTON: GeoPoint = { lat: 17.9714, lng: -76.7932 };
const PORTMORE: GeoPoint = { lat: 17.9266, lng: -76.803 };

describe("FareEngine.quote", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0)); // noon: no night surcharge
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies a zone-pair fare rule with the min-fee floor", async () => {
    const { app } = makeApp({ rule: { fee: 100, minFee: 250 }, zones: [row("z1", "Kingston", 300, 50)] });
    const q = await new FareEngine(app, new ZonesService(app)).quote({ fromPoint: KINGSTON, toPoint: PORTMORE });
    expect(q.fee.amount).toBe(250);
    expect(q.routingProvider).toBe("fake");
    expect(q.distanceM).toBe(10_000);
    expect(q.durationS).toBe(1200);
  });

  it("uses destination zone base + per-km when no rule matches", async () => {
    const { app } = makeApp({ rule: null, zones: [row("z1", "Kingston", 300, 50)] });
    const q = await new FareEngine(app, new ZonesService(app)).quote({ fromPoint: KINGSTON, toPoint: PORTMORE });
    // 300 base + 10 km * 50/km
    expect(q.fee.amount).toBe(800);
  });

  it("estimates from distance when there is no zone data", async () => {
    const { app } = makeApp({ rule: null, zones: [] });
    const q = await new FareEngine(app, new ZonesService(app)).quote({ fromPoint: KINGSTON, toPoint: PORTMORE });
    expect(q.fee.amount).toBe(150); // 10 km * 15 JMD/km
    expect(q.breakdown.some((b) => b.label.includes("Distance estimate"))).toBe(true);
  });

  it("adds the express surcharge on top of the rule fee", async () => {
    const { app } = makeApp({ rule: { fee: 400, minFee: null }, zones: [row("z1", "Kingston", 300, 50)] });
    const q = await new FareEngine(app, new ZonesService(app)).quote({ fromPoint: KINGSTON, toPoint: PORTMORE, express: true });
    expect(q.fee.amount).toBe(500); // 400 * 1.25
  });

  it("adds the destination zone's flat urgent surcharge when urgent is requested", async () => {
    const { app } = makeApp({ rule: null, zones: [row("z1", "Portmore", 300, 50, 150)] });
    const q = await new FareEngine(app, new ZonesService(app)).quote({ fromPoint: KINGSTON, toPoint: PORTMORE, urgent: true });
    // 300 base + 10km*50/km = 800, + flat 150 urgent surcharge = 950
    expect(q.fee.amount).toBe(950);
    expect(q.breakdown.some((b) => b.label === "Urgent delivery")).toBe(true);
  });

  it("does not add an urgent surcharge when the zone has none configured", async () => {
    const { app } = makeApp({ rule: null, zones: [row("z1", "Kingston", 300, 50, null)] });
    const q = await new FareEngine(app, new ZonesService(app)).quote({ fromPoint: KINGSTON, toPoint: PORTMORE, urgent: true });
    expect(q.fee.amount).toBe(800); // unchanged from the non-urgent case
    expect(q.breakdown.some((b) => b.label === "Urgent delivery")).toBe(false);
  });
});

describe("QuoteBody", () => {
  it("rejects out-of-range or incomplete points", () => {
    expect(() => QuoteBody.parse({ fromPoint: { lat: 91, lng: 0 }, toPoint: { lat: 0, lng: 0 } })).toThrow();
    expect(() => QuoteBody.parse({ fromPoint: { lat: 17.9, lng: -76.8 } })).toThrow();
  });
});

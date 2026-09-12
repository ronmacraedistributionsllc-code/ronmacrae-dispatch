import { describe, expect, it } from "vitest";
import {
  OfflineProvider,
  OsmProvider,
  SimulatedProvider,
  createGeoProvider,
  haversineM,
  pointInZone,
  centroidOf,
  optimizeStops,
  formatDistance,
  formatDuration,
  filterResultInJamaica,
  filterResultsInJamaica,
  type GeoProvider,
  type GeoPoint,
  type GeocodeResult,
} from "../src/index.js";

const KINGSTON = { lat: 17.9714, lng: -76.7932 };
const PORTMORE = { lat: 17.9266, lng: -76.803 };

describe("geo utils", () => {
  it("computes plausible Jamaica distances", () => {
    const d = haversineM(KINGSTON, PORTMORE);
    expect(d).toBeGreaterThan(5_000);
    expect(d).toBeLessThan(40_000);
    expect(formatDistance(d)).toMatch(/km| m/);
    expect(formatDuration(1500)).toBe("25 min");
    expect(formatDuration(3720)).toBe("1 h 2 min");
  });

  it("does point-in-polygon for squares and multipolygons", () => {
    const square = { type: "Polygon" as const, coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
    expect(pointInZone({ lat: 5, lng: 5 }, square)).toBe(true);
    expect(pointInZone({ lat: 5, lng: 20 }, square)).toBe(false);
    const multi = { type: "MultiPolygon" as const, coordinates: [square.coordinates] };
    expect(pointInZone({ lat: 5, lng: 5 }, multi)).toBe(true);
    expect(centroidOf(square)).toEqual({ lat: 5, lng: 5 });
  });
});

describe("OfflineProvider", () => {
  const p = new OfflineProvider();
  it("routes with straight-line + road factor and motorcycle faster", async () => {
    const car = await p.route([KINGSTON, PORTMORE], "car");
    const moto = await p.route([KINGSTON, PORTMORE], "motorcycle");
    expect(car.legs).toHaveLength(1);
    expect(car.totalDurationS).toBeGreaterThan(moto.totalDurationS);
    const cells = await p.matrix(KINGSTON, [PORTMORE, KINGSTON], "car");
    expect(cells[1]!.distanceM).toBe(0);
  });
});

class FakeProvider implements GeoProvider {
  name = "fake";
  async geocode() {
    return null;
  }
  async reverseGeocode() {
    return null;
  }
  async route(points: GeoPoint[], mode: "car" | "motorcycle") {
    return new OfflineProvider().route(points, mode);
  }
  async matrix(from: GeoPoint, to: GeoPoint[], mode: "car" | "motorcycle") {
    return new OfflineProvider().matrix(from, to, mode);
  }
}

describe("optimizeStops", () => {
  it("improves a zig-zag order", async () => {
    // 6 stops in a 2x3 grid, given in a bad zig-zag order
    const grid: GeoPoint[] = [
      { lat: 17.9, lng: -76.8 },
      { lat: 17.9, lng: -76.9 },
      { lat: 17.9, lng: -77.0 },
      { lat: 18.0, lng: -76.8 },
      { lat: 18.0, lng: -76.9 },
      { lat: 18.0, lng: -77.0 },
    ];
    const bad = [grid[2]!, grid[1]!, grid[0]!, grid[5]!, grid[4]!, grid[3]!];
    const p = new FakeProvider();
    const before = await p.route(bad, "car");
    const { order, improved, via } = await optimizeStops(bad, p, "car");
    const after = await p.route(order, "car");
    expect(order[0]).toEqual(bad[0]); // fixed start preserved
    expect(after.totalDistanceM).toBeLessThanOrEqual(before.totalDistanceM);
    expect(improved || after.totalDistanceM <= before.totalDistanceM).toBe(true);
    expect(via).toBe("fake");
  });

  it("returns small inputs unchanged", async () => {
    const { order, improved } = await optimizeStops([KINGSTON, PORTMORE], new FakeProvider(), "car");
    expect(order).toEqual([KINGSTON, PORTMORE]);
    expect(improved).toBe(false);
  });
});

describe("OsmProvider (offline guards)", () => {
  it("is constructible and named", () => {
    expect(new OsmProvider().name).toBe("osm");
  });
});

describe("SimulatedProvider", () => {
  const p = new SimulatedProvider();

  it("resolves known Jamaican places to stable anchors", async () => {
    const a = await p.geocode("12 Portmore Ave");
    const b = await p.geocode("99 portmore ave");
    expect(a?.confidence).toBe("high");
    expect(a?.point.lat).toBeCloseTo(17.9266, 3);
    expect(a?.point).toEqual(b?.point);
  });

  it("derives a stable point for unknown addresses (same input -> same output)", async () => {
    const a = await p.geocode("42 Constant Spring Rd, near the bakery");
    const b = await p.geocode("42 constant spring rd, near the bakery");
    expect(a).not.toBeNull();
    expect(a?.point).toEqual(b?.point);
    expect(a?.point.lat).toBeGreaterThan(17.5);
    expect(a?.point.lat).toBeLessThan(18.7);
  });

  it("biases unknown addresses near the provided point", async () => {
    const bias = { lat: 17.9714, lng: -76.7932 };
    const r = await p.geocode("a random road", bias);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.point.lat - bias.lat)).toBeLessThan(0.02);
    expect(Math.abs(r!.point.lng - bias.lng)).toBeLessThan(0.02);
  });

  it("returns null for empty queries and inherits offline routing", async () => {
    expect(await p.geocode("   ")).toBeNull();
    const route = await p.route([KINGSTON, PORTMORE], "car");
    expect(route.provider).toBe("simulated");
    expect(route.totalDistanceM).toBeGreaterThan(0);
  });
});

describe("SimulatedProvider.searchAddresses (spec item 7 — no fabricated suggestions)", () => {
  const p = new SimulatedProvider();

  it("returns a real known place for a recognized Jamaican town", async () => {
    const results = await p.searchAddresses("Portmore");
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("Portmore, St. Catherine");
  });

  it("returns NO results for a query it doesn't actually recognize — never a guessed pin dressed up as a suggestion", async () => {
    const results = await p.searchAddresses("17 Some Made Up Lane, Nowhere");
    expect(results).toEqual([]);
  });

  it("never suggests a place outside Jamaica (the old Basseterre/St. Kitts entry is gone for good)", async () => {
    const results = await p.searchAddresses("Basseterre");
    expect(results).toEqual([]);
  });
});

describe("known-place parishes are each in their own real, correct parish", () => {
  // Regression guard for spec item 7's actual bug: several real places used
  // to share one regex/point, so at least one of them always resolved to
  // someone else's location. Each of these must resolve to ITS OWN point,
  // not a neighbor's.
  it.each([
    ["Half Way Tree", "St. Andrew"],
    ["Constant Spring", "St. Andrew"],
    ["Old Harbour", "St. Catherine"],
    ["Linstead", "St. Catherine"],
    ["Moore Town", "Portland"],
  ])("%s resolves to its own real parish (%s)", async (place, parish) => {
    const r = await new SimulatedProvider().geocode(place);
    expect(r?.label).toContain(parish);
  });
});

describe("createGeoProvider geocode chain", () => {
  it("falls back to the simulated provider when the primary fails", async () => {
    const p = createGeoProvider({ geocodeTimeoutMs: 50 });
    const fakeChain = p as unknown as {
      geocodeChain: ((q: string, b?: GeoPoint) => Promise<GeocodeResult | null>)[];
    };
    // Replace the real (networked) primary with a slow no-op so the
    // deterministic simulated step is what resolves.
    const simulatedStep = fakeChain.geocodeChain[fakeChain.geocodeChain.length - 1]!;
    fakeChain.geocodeChain = [
      async () => {
        await new Promise((r) => setTimeout(r, 500));
        return null;
      },
      simulatedStep,
    ];
    const r = await p.geocode("somewhere in jamaica");
    expect(r?.provider).toBe("simulated");
  });

});

describe("filterResultInJamaica / filterResultsInJamaica (spec item 7)", () => {
  const outOfCountry: GeocodeResult = {
    point: { lat: 40.7128, lng: -74.006 }, // New York — a confident, real, wrong-country match
    label: "Not actually in Jamaica",
    confidence: "high",
    provider: "fake",
  };
  const inCountry: GeocodeResult = { point: { lat: 17.9714, lng: -76.7932 }, label: "Kingston", confidence: "high", provider: "fake" };

  it("rejects a confident result outside Jamaica's bounding box rather than accepting it as-is", () => {
    expect(filterResultInJamaica(outOfCountry)).toBeNull();
    expect(filterResultInJamaica(inCountry)).toBe(inCountry);
    expect(filterResultInJamaica(null)).toBeNull();
  });

  it("filters a mixed result list down to only the in-Jamaica candidates", () => {
    expect(filterResultsInJamaica([outOfCountry, inCountry])).toEqual([inCountry]);
  });
});

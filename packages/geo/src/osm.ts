import type { GeoPoint } from "@ronmacrae/contracts";
import { haversineM, type GeoProvider, type GeocodeResult, type MatrixCell, type Route, type RouteLeg, type RouteMode } from "./types.js";
import { fetchJson, RateLimiter, TtlCache } from "./offline.js";

/**
 * Keyless fallback: OpenStreetMap Nominatim (geocoding) + OSRM (routing/matrix).
 * Perfectly adequate for preview/dev and as a production backup; not for
 * turn-by-turn-grade navigation in production (use Google when keyed).
 */
export class OsmProvider implements GeoProvider {
  readonly name = "osm";
  private nominatim = new RateLimiter(1100);
  private osrm = new RateLimiter(250);
  private searchCache = new TtlCache<GeocodeResult[]>(1000 * 60 * 60 * 24, 5000);
  private reverseCache = new TtlCache<string>(1000 * 60 * 60 * 24, 5000);
  private matrixCache = new TtlCache<MatrixCell[]>(1000 * 60 * 30, 1000);

  constructor(
    private readonly base = {
      nominatim: "https://nominatim.openstreetmap.org",
      osrm: "https://router.project-osrm.org",
    },
  ) {}

  async geocode(query: string, bias?: GeoPoint): Promise<GeocodeResult | null> {
    const results = await this.searchAddresses(query, bias, 1);
    return results[0] ?? null;
  }

  async searchAddresses(query: string, bias?: GeoPoint, limit = 5): Promise<GeocodeResult[]> {
    const key = `search:${limit}:${bias ? `${bias.lat.toFixed(3)},${bias.lng.toFixed(3)}` : ""}:${query}`;
    const cached = this.searchCache.get(key);
    if (cached) return cached;
    await this.nominatim.wait();
    const url = new URL(`${this.base.nominatim}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", String(Math.max(1, Math.min(10, limit))));
    if (bias) {
      url.searchParams.set("viewbox", `${bias.lng - 0.2},${bias.lat - 0.2},${bias.lng + 0.2},${bias.lat + 0.2}`);
      url.searchParams.set("bounded", "1");
    }
    const data = (await fetchJson(url.toString())) as {
      display_name?: string;
      lat?: string;
      lon?: string;
    }[];
    const results: GeocodeResult[] = data
      .filter((d) => d.lat && d.lon)
      .map((d) => ({
        point: { lat: Number(d.lat), lng: Number(d.lon) },
        label: d.display_name ?? query,
        confidence: "medium" as const,
        provider: this.name,
      }));
    this.searchCache.set(key, results);
    return results;
  }

  async reverseGeocode(point: GeoPoint): Promise<string | null> {
    const key = `rev:${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
    const cached = this.reverseCache.get(key);
    if (cached) return cached;
    await this.nominatim.wait();
    const url = new URL(`${this.base.nominatim}/reverse`);
    url.searchParams.set("lat", String(point.lat));
    url.searchParams.set("lon", String(point.lng));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "17");
    const data = (await fetchJson(url.toString())) as { display_name?: string };
    const label = data.display_name ?? null;
    if (label) this.reverseCache.set(key, label);
    return label;
  }

  async route(points: GeoPoint[], mode: RouteMode): Promise<Route> {
    if (points.length < 2) {
      return { mode, provider: this.name, legs: [], totalDistanceM: 0, totalDurationS: 0 };
    }
    await this.osrm.wait();
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = new URL(`${this.base.osrm}/route/v1/driving/${coords}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("annotations", "distance,duration");
    const data = (await fetchJson(url.toString())) as {
      code: string;
      routes?: {
        distance: number;
        duration: number;
        geometry: { coordinates: [number, number][] };
      }[];
    };
    if (data.code !== "Ok" || !data.routes?.[0]) throw new Error(`OSRM: ${data.code}`);
    const r = data.routes[0]!;
    // OSRM returns a single geometry for the whole trip; approximate per-stop legs
    // by slicing the geometry proportionally to segment distance.
    const legs: RouteLeg[] = [];
    let legDistance = 0;
    let legDuration = 0;
    const poly = r.geometry.coordinates.map(([x, y]) => ({ lat: y, lng: x }));
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      const seg = haversineM(points[i - 1]!, points[i]!) * 1.3;
      const frac = r.distance > 0 ? seg / r.distance : 1 / (points.length - 1);
      legDistance += r.distance * frac;
      legDuration += r.duration * frac;
      const startIdx = Math.min(poly.length - 1, Math.round((acc / Math.max(1, r.distance)) * poly.length));
      const endIdx = Math.min(poly.length - 1, Math.round(((acc + seg) / Math.max(1, r.distance)) * poly.length));
      legs.push({
        point: points[i]!,
        distanceM: Math.round(legDistance - 0),
        durationS: Math.round(legDuration),
        polyline: poly.slice(startIdx, endIdx + 1),
      });
      acc += seg;
    }
    return {
      mode,
      provider: this.name,
      legs,
      totalDistanceM: Math.round(r.distance),
      totalDurationS: Math.round(r.duration),
    };
  }

  async matrix(from: GeoPoint, to: GeoPoint[], _mode: RouteMode): Promise<MatrixCell[]> {
    if (to.length === 0) return [];
    const key = `mat:${from.lat.toFixed(5)},${from.lng.toFixed(5)}:${to
      .map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`)
      .join("|")}`;
    const cached = this.matrixCache.get(key);
    if (cached) return cached;
    await this.osrm.wait();
    const coords = [from, ...to].map((p) => `${p.lng},${p.lat}`).join(";");
    const url = new URL(`${this.base.osrm}/table/v1/driving/${coords}`);
    url.searchParams.set("annotations", "true");
    const data = (await fetchJson(url.toString())) as {
      distances?: number[][];
      durations?: number[][];
    };
    const cells = to.map((_, i) => ({
      distanceM: Math.round(data.distances?.[0]?.[i + 1] ?? haversineM(from, to[i]!) * 1.3),
      durationS: Math.round(data.durations?.[0]?.[i + 1] ?? 0),
    }));
    this.matrixCache.set(key, cells);
    return cells;
  }
}

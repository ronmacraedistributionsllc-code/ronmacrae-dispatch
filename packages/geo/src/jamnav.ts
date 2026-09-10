import type { GeoPoint } from "@ronmacrae/contracts";
import type { GeocodeResult } from "./types.js";
import { fetchJson, TtlCache } from "./offline.js";

/**
 * JAMNAV (Mona GeoInformatics Institute, UWI) - Jamaica's geospatial database.
 * 1.5M+ data points: settlements, parishes, points of interest, road segments.
 * Used as a Jamaica-first geocoding fallback for landmark-based addresses
 * that Google misses (e.g. "corner shop by the Old Harbour bus stop").
 *
 * Docs: https://api.jamnav.com/docs/
 */
export class JamnavProvider {
  readonly name = "jamnav";
  private cache = new TtlCache<GeocodeResult | null>(1000 * 60 * 60 * 24 * 30, 5000);

  constructor(
    private readonly apiKey: string | null = null,
    private readonly baseUrl = "https://api.jamnav.com/v1",
  ) {}

  private headers(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  private async search(endpoint: string, params: Record<string, string>): Promise<GeocodeResult | null> {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const data = (await fetchJson(url.toString(), { headers: this.headers() })) as {
      features?: {
        geometry?: { type: string; coordinates: unknown };
        properties?: Record<string, unknown>;
      }[];
    };
    const feature = data.features?.find((f) => f.geometry?.type === "Point");
    const coords = feature?.geometry?.coordinates as [number, number] | undefined;
    if (!coords || coords.length < 2) return null;
    const name =
      (feature?.properties?.name as string | undefined) ??
      (feature?.properties?.comm_name as string | undefined) ??
      null;
    return {
      point: { lat: coords[1]!, lng: coords[0]! },
      label: name ?? "",
      confidence: "medium",
      provider: this.name,
    };
  }

  /** Try POIs then settlements; returns null if nothing resolves. */
  async geocode(query: string): Promise<GeocodeResult | null> {
    const key = `j:${query.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let result: GeocodeResult | null = null;
    try {
      result = (await this.search("locations", { name: query })) ?? (await this.search("settlements", { name: query }));
    } catch {
      result = null;
    }
    this.cache.set(key, result);
    return result;
  }
}

/** Bias a JAMNAV result toward a Jamaica bounding box (safety filter). */
export function inJamaica(p: GeoPoint | null): p is GeoPoint {
  return !!p && p.lat >= 17.5 && p.lat <= 18.6 && p.lng >= -78.6 && p.lng <= -76.0;
}

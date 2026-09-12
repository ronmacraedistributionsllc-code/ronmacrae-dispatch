import type { GeoPoint } from "@ronmacrae/contracts";
import { haversineM, type GeoProvider, type GeocodeResult, type MatrixCell, type Route, type RouteMode } from "./types.js";
import { OfflineProvider } from "./offline.js";
import { OsmProvider } from "./osm.js";
import { GoogleProvider } from "./google.js";
import { JamnavProvider, inJamaica } from "./jamnav.js";
import { SimulatedProvider } from "./simulated.js";

export interface GeoConfig {
  googleApiKey?: string;
  jamnavApiKey?: string;
  jamnavEnabled?: boolean;
  osmNominatimBase?: string;
  osrMRouteBase?: string;
  /** per-step geocode budget; a step that exceeds it is skipped for the next fallback (default 5s) */
  geocodeTimeoutMs?: number;
}

/**
 * A result outside Jamaica's own bounding box is never a real match, no
 * matter how confidently the provider returned it — an unrestricted
 * geocoder can (and does) resolve a same-named place in another country
 * entirely (spec item 7: "wrong parish" is really "not Jamaica at all").
 * The country-restriction params on OSM/Google narrow the *query*; this is
 * the belt-and-braces check on the *result*, since neither restriction is
 * airtight (Google's `components` filter has known edge cases, and a
 * provider called without those params — JAMNAV, a future addition — gets
 * no such guarantee at all). A rejected result here just falls through to
 * the next step in the chain, same as a real network failure.
 */
export function filterResultInJamaica(r: GeocodeResult | null): GeocodeResult | null {
  return r && inJamaica(r.point) ? r : null;
}

export function filterResultsInJamaica(results: GeocodeResult[]): GeocodeResult[] {
  return results.filter((r) => inJamaica(r.point));
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resilient composite:
 * - routing/matrix: primary (Google if keyed, else OSM) with offline fallback
 * - geocoding: chain of [primary, JAMNAV] - JAMNAV resolves Jamaican landmarks
 */
export class CompositeGeoProvider implements GeoProvider {
  readonly name = "composite";
  private primary: GeoProvider;
  private geocodeChain: ((q: string, bias?: GeoPoint) => Promise<GeocodeResult | null>)[];
  private searchChain: ((q: string, bias?: GeoPoint, limit?: number) => Promise<GeocodeResult[]>)[];
  private readonly offline = new OfflineProvider();
  private readonly simulated = new SimulatedProvider();
  private readonly geocodeTimeoutMs: number;

  constructor(cfg: GeoConfig) {
    const osm = new OsmProvider(
      cfg.osmNominatimBase || cfg.osrMRouteBase
        ? {
            nominatim: cfg.osmNominatimBase ?? "https://nominatim.openstreetmap.org",
            osrm: cfg.osrMRouteBase ?? "https://router.project-osrm.org",
          }
        : undefined,
    );
    this.primary = cfg.googleApiKey ? new GoogleProvider(cfg.googleApiKey) : osm;
    this.geocodeTimeoutMs = cfg.geocodeTimeoutMs ?? 5_000;

    const bounded = (step: (q: string, b?: GeoPoint) => Promise<GeocodeResult | null>) =>
      (q: string, b?: GeoPoint) => withTimeout(step(q, b), this.geocodeTimeoutMs, null).then(filterResultInJamaica);
    /** A provider without native multi-result support falls back to its single geocode(). */
    const boundedSearch = (provider: Pick<GeoProvider, "geocode" | "searchAddresses">) =>
      (q: string, b?: GeoPoint, limit?: number) =>
        withTimeout(
          provider.searchAddresses
            ? provider.searchAddresses(q, b, limit)
            : provider.geocode(q, b).then((r) => (r ? [r] : [])),
          this.geocodeTimeoutMs,
          [] as GeocodeResult[],
        ).then(filterResultsInJamaica);

    const chain: ((q: string, bias?: GeoPoint) => Promise<GeocodeResult | null>)[] = [
      bounded((q, b) => this.primary.geocode(q, b)),
    ];
    const searchChain: ((q: string, bias?: GeoPoint, limit?: number) => Promise<GeocodeResult[]>)[] = [
      boundedSearch(this.primary),
    ];
    if (cfg.jamnavEnabled || cfg.jamnavApiKey) {
      const jamnav = new JamnavProvider(cfg.jamnavApiKey || null);
      chain.push(bounded((q) => jamnav.geocode(q)));
      searchChain.push(boundedSearch(jamnav));
    }
    if (this.primary.name !== "osm") {
      chain.push(bounded((q, b) => osm.geocode(q, b)));
      searchChain.push(boundedSearch(osm));
    }
    // deterministic, network-free last resort: the preview always geocodes
    chain.push(bounded((q, b) => this.simulated.geocode(q, b)));
    searchChain.push(boundedSearch(this.simulated));
    this.geocodeChain = chain;
    this.searchChain = searchChain;
  }

  get routingProviderName(): string {
    return this.primary.name;
  }

  async geocode(query: string, bias?: GeoPoint): Promise<GeocodeResult | null> {
    for (const step of this.geocodeChain) {
      try {
        const r = await step(query, bias);
        if (r) return r;
      } catch {
        // try next in chain
      }
    }
    return null;
  }

  /**
   * Ranked address suggestions for a search-as-you-type UI. Same failover chain
   * as geocode() (primary -> JAMNAV -> OSM -> deterministic offline), stopping at
   * the first step that returns any results. The deterministic simulated
   * provider guarantees this never throws / never returns empty for a non-blank
   * query, but always as exactly one result labeled `provider: "simulated"` —
   * callers should treat that as "address search is degraded" and say so.
   */
  async searchAddresses(query: string, bias?: GeoPoint, limit = 5): Promise<GeocodeResult[]> {
    for (const step of this.searchChain) {
      try {
        const results = await step(query, bias, limit);
        if (results.length > 0) return results;
      } catch {
        // try next in chain
      }
    }
    return [];
  }

  async reverseGeocode(point: GeoPoint): Promise<string | null> {
    try {
      return await this.primary.reverseGeocode(point);
    } catch {
      return null;
    }
  }

  async route(points: GeoPoint[], mode: RouteMode): Promise<Route> {
    try {
      return await this.primary.route(points, mode);
    } catch {
      return this.offline.route(points, mode);
    }
  }

  async matrix(from: GeoPoint, to: GeoPoint[], mode: RouteMode): Promise<MatrixCell[]> {
    try {
      return await this.primary.matrix(from, to, mode);
    } catch {
      return this.offline.matrix(from, to, mode);
    }
  }
}

export function createGeoProvider(cfg: GeoConfig): CompositeGeoProvider {
  return new CompositeGeoProvider(cfg);
}

/**
 * Stop-order optimization (up to ~25 stops):
 * full distance matrix from the provider + 2-opt improvement.
 * Falls back to great-circle heuristic if the provider matrix fails.
 * `fixedStart` keeps the first point (current location / depot) in place.
 */
export async function optimizeStops(
  points: GeoPoint[],
  provider: GeoProvider,
  mode: RouteMode,
  opts: { fixedStart?: boolean } = {},
): Promise<{ order: GeoPoint[]; improved: boolean; via: string }> {
  const fixedStart = opts.fixedStart ?? true;
  if (points.length < 3) return { order: points, improved: false, via: provider.name };

  const n = points.length;
  const dist: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let via = provider.name;
  try {
    for (let i = 0; i < n; i++) {
      const cells = await provider.matrix(points[i]!, points.filter((_, j) => j !== i), mode);
      let k = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        dist[i]![j] = cells[k++]!.distanceM;
      }
    }
  } catch {
    via = "offline-heuristic";
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) dist[i]![j] = haversineM(points[i]!, points[j]!) * 1.3;
    }
  }

  let order = points.map((_, i) => i);
  const total = (o: number[]) =>
    o.slice(1).reduce((s, idx, k) => s + dist[o[k]!]![idx]!, 0);
  let best = total(order);
  let improved = false;
  const fixedLen = fixedStart ? 1 : 0;
  let pass = true;
  while (pass) {
    pass = false;
    for (let i = fixedLen; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const candidate = [...order];
        const segment = candidate.slice(i, k + 1).reverse();
        candidate.splice(i, k + 1 - i, ...segment);
        const d = total(candidate);
        if (d < best - 1) {
          order = candidate;
          best = d;
          improved = true;
          pass = true;
        }
      }
    }
  }
  return { order: order.map((i) => points[i]!), improved, via };
}

import type { GeoPoint } from "@ronmacrae/contracts";
import { haversineM, type GeoProvider, type GeocodeResult, type MatrixCell, type Route, type RouteLeg, type RouteMode } from "./types.js";

const SPEED_KMH: Record<RouteMode, number> = { car: 38, motorcycle: 48 };
const ROAD_FACTOR = 1.3;

/**
 * Network-free provider: straight-line legs with Jamaican road speed assumptions.
 * Used when no map API key is configured or the network is unavailable, and
 * as the last-resort fallback inside `createGeoProvider`.
 */
export class OfflineProvider implements GeoProvider {
  readonly name: string = "offline";

  async geocode(_query: string, _bias?: GeoPoint): Promise<GeocodeResult | null> {
    return null;
  }

  async reverseGeocode(_point: GeoPoint): Promise<string | null> {
    return null;
  }

  async route(points: GeoPoint[], mode: RouteMode): Promise<Route> {
    const legs: RouteLeg[] = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const straight = haversineM(a, b);
      const distanceM = Math.round(straight * ROAD_FACTOR);
      const durationS = Math.round((distanceM / 1000 / SPEED_KMH[mode]) * 3600);
      legs.push({ point: b, distanceM, durationS, polyline: [a, b] });
    }
    return {
      mode,
      provider: this.name,
      legs,
      totalDistanceM: legs.reduce((s, l) => s + l.distanceM, 0),
      totalDurationS: legs.reduce((s, l) => s + l.durationS, 0),
    };
  }

  async matrix(from: GeoPoint, to: GeoPoint[], mode: RouteMode): Promise<MatrixCell[]> {
    return to.map((p) => {
      const distanceM = Math.round(haversineM(from, p) * ROAD_FACTOR);
      return { distanceM, durationS: Math.round((distanceM / 1000 / SPEED_KMH[mode]) * 3600) };
    });
  }
}

/** Serial rate limiter - keeps shared public endpoints happy. */
export class RateLimiter {
  private last = 0;
  constructor(private readonly minGapMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const waitMs = this.last + this.minGapMs - now;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    this.last = Date.now();
  }
}

/** Tiny TTL cache for geocodes/reverse geocodes to cut provider calls. */
export class TtlCache<V> {
  private map = new Map<string, { v: V; at: number }>();
  constructor(private readonly ttlMs: number, private readonly max = 2000) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.v;
  }

  set(key: string, v: V): void {
    if (this.map.size > this.max) this.map.clear();
    this.map.set(key, { v, at: Date.now() });
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": "ronmacrae-dispatch/0.1 (delivery logistics)", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as unknown;
}

export { fetchJson };

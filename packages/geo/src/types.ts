import type { GeoPoint, ZoneGeometry } from "@ronmacrae/contracts";

export type RouteMode = "car" | "motorcycle";

export interface GeocodeResult {
  point: GeoPoint;
  label: string;
  confidence: "high" | "medium" | "low";
  provider: string;
}

export interface RouteLeg {
  /** the stop this leg ends at */
  point: GeoPoint;
  distanceM: number;
  durationS: number;
  polyline: GeoPoint[];
}

export interface Route {
  mode: RouteMode;
  provider: string;
  legs: RouteLeg[];
  totalDistanceM: number;
  totalDurationS: number;
}

export interface MatrixCell {
  distanceM: number;
  durationS: number;
}

/**
 * Provider-agnostic geospatial capability.
 * Implementations: Google (primary, key), OSM (keyless fallback),
 * JAMNAV (Jamaica-first geocoding), Offline (no network, straight lines).
 */
export interface GeoProvider {
  readonly name: string;
  geocode(query: string, bias?: GeoPoint): Promise<GeocodeResult | null>;
  reverseGeocode(point: GeoPoint): Promise<string | null>;
  route(points: GeoPoint[], mode: RouteMode): Promise<Route>;
  matrix(from: GeoPoint, to: GeoPoint[], mode: RouteMode): Promise<MatrixCell[]>;
}

/** Great-circle distance in meters. */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Point-in-polygon (ray casting) over a GeoJSON Polygon/MultiPolygon.
 * Coordinates are [lng, lat] per the GeoJSON spec.
 */
export function pointInZone(point: GeoPoint, zone: ZoneGeometry): boolean {
  const rings = zone.type === "Polygon" ? [zone.coordinates] : zone.coordinates;
  const x = point.lng;
  const y = point.lat;
  for (const polygon of rings) {
    const outer = polygon?.[0];
    if (!outer || outer.length < 4) continue;
    let inside = false;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [xi, yi] = outer[i]!;
      const [xj, yj] = outer[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

/** Average point of a polygon (outer rings), for map centering. */
export function centroidOf(zone: ZoneGeometry): GeoPoint {
  const rings = zone.type === "Polygon" ? [zone.coordinates] : zone.coordinates;
  let lat = 0;
  let lng = 0;
  let n = 0;
  for (const polygon of rings) {
    const outer = polygon?.[0];
    if (!outer || outer.length < 2) continue;
    // skip the repeated closing vertex
    const pts = outer[0]!.join(",") === outer[outer.length - 1]!.join(",") ? outer.slice(0, -1) : outer;
    for (const [x, y] of pts) {
      lng += x;
      lat += y;
      n++;
    }
  }
  return n > 0 ? { lat: lat / n, lng: lng / n } : { lat: 17.9714, lng: -76.7932 };
}

export function formatDistance(m: number | null): string {
  if (m == null) return "–";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function formatDuration(s: number | null): string {
  if (s == null) return "–";
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Build an `ETA` ISO string: now + duration, given a start time. */
export function etaAt(from: Date, durationS: number): string {
  return new Date(from.getTime() + durationS * 1000).toISOString();
}

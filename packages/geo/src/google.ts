import type { GeoPoint } from "@ronmacrae/contracts";
import type { GeoProvider, GeocodeResult, MatrixCell, Route, RouteLeg, RouteMode } from "./types.js";
import { fetchJson, RateLimiter, TtlCache } from "./offline.js";
import { haversineM } from "./types.js";

/**
 * Google Maps Platform provider (primary).
 * Uses the REST APIs directly (no SDK): Geocoding, Routes v2, Optimization v1.
 */
export class GoogleProvider implements GeoProvider {
  readonly name = "google";
  private limiter = new RateLimiter(120);
  private geocodeCache = new TtlCache<GeocodeResult>(1000 * 60 * 60 * 24 * 7, 5000);
  private reverseCache = new TtlCache<string>(1000 * 60 * 60 * 24 * 7, 5000);

  constructor(private readonly apiKey: string) {}

  private headers() {
    return { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" };
  }

  async geocode(query: string, bias?: GeoPoint): Promise<GeocodeResult | null> {
    const key = `geo:${query}:${bias ? bias.lat.toFixed(3) : ""}`;
    const cached = this.geocodeCache.get(key);
    if (cached) return cached;
    await this.limiter.wait();
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", query);
    // This app is Jamaica-only — without a country restriction, Google's
    // geocoder can match a same-named place elsewhere (the "wrong parish"
    // bug, spec item 7, isn't a bad Jamaican match, it's not Jamaica at
    // all). `region` biases; `components` actually filters.
    url.searchParams.set("region", "jm");
    url.searchParams.set("components", "country:JM");
    if (bias) url.searchParams.set("bounds", `${bias.lat - 0.5},${bias.lng - 0.5}|${bias.lat + 0.5},${bias.lng + 0.5}`);
    url.searchParams.set("key", this.apiKey);
    const data = (await fetchJson(url.toString())) as {
      status: string;
      results?: {
        geometry: { location: { lat: number; lng: number } };
        formatted_address: string;
        types?: string[];
      }[];
    };
    if (data.status !== "OK" || !data.results?.[0]) return null;
    const r = data.results[0]!;
    const result: GeocodeResult = {
      point: { lat: r.geometry.location.lat, lng: r.geometry.location.lng },
      label: r.formatted_address,
      confidence: r.types?.includes("premise") ? "high" : r.types?.includes("route") ? "medium" : "medium",
      provider: this.name,
    };
    this.geocodeCache.set(key, result);
    return result;
  }

  async reverseGeocode(point: GeoPoint): Promise<string | null> {
    const key = `rev:${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
    const cached = this.reverseCache.get(key);
    if (cached) return cached;
    await this.limiter.wait();
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${point.lat},${point.lng}`);
    url.searchParams.set("key", this.apiKey);
    const data = (await fetchJson(url.toString())) as {
      status: string;
      results?: { formatted_address: string }[];
    };
    const label = data.status === "OK" ? (data.results?.[0]?.formatted_address ?? null) : null;
    if (label) this.reverseCache.set(key, label);
    return label;
  }

  private decodePolyline(encoded: string): GeoPoint[] {
    const pts: GeoPoint[] = [];
    let lat = 0;
    let lng = 0;
    let i = 0;
    while (i < encoded.length) {
      let shift = 0;
      let v = 0;
      do {
        v = (encoded.charCodeAt(i) & 0x1f) << shift;
        shift += 5;
        i++;
      } while (encoded.charCodeAt(i - 1) & 0x20);
      lat += v & 1 ? ~(v >> 1) : v >> 1;
      shift = 0;
      v = 0;
      do {
        v = (encoded.charCodeAt(i) & 0x1f) << shift;
        shift += 5;
        i++;
      } while (encoded.charCodeAt(i - 1) & 0x20);
      lng += v & 1 ? ~(v >> 1) : v >> 1;
      pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return pts;
  }

  async route(points: GeoPoint[], mode: RouteMode): Promise<Route> {
    if (points.length < 2) {
      return { mode, provider: this.name, legs: [], totalDistanceM: 0, totalDurationS: 0 };
    }
    await this.limiter.wait();
    const body = {
      origin: { location: { latitude: points[0]!.lat, longitude: points[0]!.lng } },
      destination: { location: { latitude: points[points.length - 1]!.lat, longitude: points[points.length - 1]!.lng } },
      routeModifiers: { trafficAwareness: "TRAFFIC_AWARE" },
      travelMode: mode === "motorcycle" ? "TWO_WHEELER" : "CAR",
      routingOption: "FASTEST",
      computeOptions: { computePolyline: true, computeRoutes: 1, computeTrafficImpact: false },
      intermediateStops: points.slice(1, -1).map((p) => ({ location: { latitude: p.lat, longitude: p.lng } })),
    };
    const data = (await fetchJson("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    })) as {
      routes?: {
        summary: { distanceMeters: number; duration: string };
        polyline?: { encodedPolyline: string };
        legs: {
          distanceMeters: number;
          duration: string;
          polyline?: { encodedPolyline: string };
        }[];
      }[];
    };
    const r = data.routes?.[0];
    if (!r) throw new Error("Google Routes: no route returned");
    const dur = (s: string) => Math.round(Number.parseFloat(s) * 1000) / 1000;
    const fullPoly = r.polyline ? this.decodePolyline(r.polyline.encodedPolyline) : [];
    const legs: RouteLeg[] = r.legs.map((leg, i) => ({
      point: points[i + 1]!,
      distanceM: Math.round(leg.distanceMeters),
      durationS: Math.round(dur(leg.duration)),
      polyline: leg.polyline ? this.decodePolyline(leg.polyline.encodedPolyline) : [],
    }));
    if (legs.length === 1 && fullPoly.length > 1) legs[0]!.polyline = fullPoly;
    return {
      mode,
      provider: this.name,
      legs,
      totalDistanceM: Math.round(r.summary.distanceMeters),
      totalDurationS: Math.round(dur(r.summary.duration)),
    };
  }

  async matrix(from: GeoPoint, to: GeoPoint[], mode: RouteMode): Promise<MatrixCell[]> {
    if (to.length === 0) return [];
    await this.limiter.wait();
    const body = {
      origin: { location: { latitude: from.lat, longitude: from.lng } },
      destinations: to.map((p) => ({ location: { latitude: p.lat, longitude: p.lng } })),
      travelMode: mode === "motorcycle" ? "TWO_WHEELER" : "CAR",
      routingOption: "FASTEST",
    };
    const data = (await fetchJson("https://routes.googleapis.com/directions/v2:computeRouteMatrix", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    })) as {
      matrixElements?: {
        summary?: { distanceMeters?: number; duration?: string };
      }[];
    };
    return to.map((p, i) => {
      const el = data.matrixElements?.[i]?.summary;
      const d = el?.distanceMeters;
      const dt = el?.duration ? Number.parseFloat(el.duration) : undefined;
      return {
        distanceM: Math.round(d ?? haversineM(from, p) * 1.3),
        durationS: dt != null ? Math.round(dt) : 0,
      };
    });
  }
}

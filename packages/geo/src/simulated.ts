import type { GeoPoint } from "@ronmacrae/contracts";
import type { GeocodeResult } from "./types.js";
import { OfflineProvider } from "./offline.js";

/**
 * Deterministic, network-free geocoder for the zero-credential preview.
 *
 * Known Jamaican places resolve to stable anchor points; any other address is
 * mapped to a stable pseudo-point derived from a hash of the text, kept inside
 * Jamaica's bounding box (biased toward the given point when provided).
 * Routing/matrix/matrix inherit the offline straight-line model.
 *
 * The composite provider treats this as the last geocode fallback, so a real
 * map key (Google/OSM/JAMNAV) always wins when it resolves.
 */

/**
 * Real Jamaican towns only, each in its own actual parish — one real place
 * per entry, never several distinct places bundled under one regex/point
 * (that was the root of spec item 7's "wrong parish" bug: a match on, say,
 * "Constant Spring Rd" used to silently resolve to a *different* place's
 * coordinates because it shared a regex with "downtown Kingston"). A place
 * genuinely outside Jamaica (the previous list had one — Basseterre, which
 * is the capital of St. Kitts, not a Jamaican town at all) is never listed
 * here, on the same principle as searchAddresses()'s own rule below: this
 * fallback would rather resolve nothing than resolve confidently wrong.
 */
const KNOWN_PLACES: { match: RegExp; label: string; point: GeoPoint }[] = [
  { match: /kingston (central|180)|downtown kingston/i, label: "Kingston Central, Kingston", point: { lat: 17.9714, lng: -76.7932 } },
  { match: /portmore/i, label: "Portmore, St. Catherine", point: { lat: 17.9266, lng: -76.803 } },
  { match: /spanish town/i, label: "Spanish Town, St. Catherine", point: { lat: 17.9986, lng: -76.8393 } },
  { match: /constant spring/i, label: "Constant Spring, St. Andrew", point: { lat: 18.0333, lng: -76.7833 } },
  { match: /new kingston/i, label: "New Kingston, St. Andrew", point: { lat: 17.9905, lng: -76.7909 } },
  { match: /half way tree/i, label: "Half Way Tree, St. Andrew", point: { lat: 17.9909, lng: -76.7973 } },
  { match: /harbour view/i, label: "Harbour View, St. Andrew", point: { lat: 17.964, lng: -76.746 } },
  { match: /falmouth/i, label: "Falmouth, Trelawny", point: { lat: 18.4941, lng: -77.6636 } },
  { match: /moore town/i, label: "Moore Town, Portland", point: { lat: 18.052, lng: -76.417 } },
  { match: /linstead/i, label: "Linstead, St. Catherine", point: { lat: 18.1341, lng: -77.0339 } },
  { match: /montego bay/i, label: "Montego Bay, St. James", point: { lat: 18.4762, lng: -77.9263 } },
  { match: /ocho rios/i, label: "Ocho Rios, St. Ann", point: { lat: 18.4074, lng: -77.1032 } },
  { match: /old harbour/i, label: "Old Harbour, St. Catherine", point: { lat: 17.941, lng: -77.1058 } },
];

// Jamaica bounding box (deg), used for the deterministic fallback
const BOX = { latMin: 17.6, latMax: 18.6, lngMin: -78.5, lngMax: -76.2 };

/** FNV-1a over the normalized query -> unsigned 32-bit hash. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Stable point for an unknown address: hash distributes over the island box,
 * biased toward `bias` (e.g. the other end of the same form) to keep quotes
 * geographically plausible.
 */
export function simulatedPoint(query: string, bias?: GeoPoint | null): { point: GeoPoint; label: string; confidence: "high" | "medium" | "low" } {
  const known = KNOWN_PLACES.find((p) => p.match.test(query));
  if (known) return { point: known.point, label: known.label, confidence: "high" };

  const h = fnv1a(query.trim().toLowerCase().replace(/\s+/g, " "));
  const f1 = (h % 10_000) / 10_000;
  const f2 = ((h / 10_000) % 10_000) / 10_000;

  let lat: number;
  let lng: number;
  if (bias) {
    // street-level jitter around the bias point (~±1.2 km)
    const dLat = (f1 - 0.5) * 0.012;
    const dLng = (f2 - 0.5) * 0.016;
    lat = bias.lat + dLat;
    lng = bias.lng + dLng;
  } else {
    lat = BOX.latMin + f1 * (BOX.latMax - BOX.latMin);
    lng = BOX.lngMin + f2 * (BOX.lngMax - BOX.lngMin);
  }
  return { point: { lat: round5(lat), lng: round5(lng) }, label: query.trim(), confidence: bias ? "medium" : "low" };
}

function round5(v: number): number {
  return Math.round(v * 100_000) / 100_000;
}

export class SimulatedProvider extends OfflineProvider {
  override readonly name = "simulated";

  override async geocode(query: string, bias?: GeoPoint): Promise<GeocodeResult | null> {
    const q = query.trim();
    if (!q) return null;
    const { point, label, confidence } = simulatedPoint(q, bias);
    return { point, label, confidence, provider: this.name };
  }

  /**
   * Spec item 7 — a real suggestion, not a guess: only ever returns a
   * candidate when the query actually matches one of the known real places
   * above. An address search this fallback doesn't recognize returns no
   * results at all rather than a hash-jittered pin dressed up as a match —
   * the frontend's own "no suggestions matched, place a pin manually"
   * path (see AddressPicker) is the honest way to handle that, not a fake
   * suggestion the rider/dispatcher might mistake for a real one.
   */
  async searchAddresses(query: string): Promise<GeocodeResult[]> {
    const known = KNOWN_PLACES.find((p) => p.match.test(query.trim()));
    return known ? [{ point: known.point, label: known.label, confidence: "high", provider: this.name }] : [];
  }

  override async reverseGeocode(point: GeoPoint): Promise<string | null> {
    for (const place of KNOWN_PLACES) {
      const dLat = Math.abs(place.point.lat - point.lat);
      const dLng = Math.abs(place.point.lng - point.lng);
      if (dLat < 0.01 && dLng < 0.013) return place.label;
    }
    return null;
  }
}

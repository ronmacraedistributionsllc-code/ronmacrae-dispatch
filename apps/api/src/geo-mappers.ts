import type { GeoPoint, ZoneDto } from "@ronmacrae/contracts";
import { money, minorOf } from "@ronmacrae/money";
import type { Prisma } from "@prisma/client";

/** Prisma Json <-> typed converters (portable across sqlite/postgres). */

export function pointFromJson(value: unknown): GeoPoint | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.lat !== "number" || typeof v.lng !== "number") return null;
  return {
    lat: v.lat,
    lng: v.lng,
    ...(typeof v.accuracyM === "number" ? { accuracyM: v.accuracyM } : {}),
  };
}

/** Returns a value assignable to Prisma's Json *input* type (not the output JsonValue). */
export function pointToJson(point: GeoPoint | null | undefined): Prisma.InputJsonValue | null {
  if (!point) return null;
  return { lat: point.lat, lng: point.lng, ...(point.accuracyM != null ? { accuracyM: point.accuracyM } : {}) };
}

/** Read a money-ish {amount, currency} from a row (fields stored as Int minor + currency code). */
export function moneyField(amount: number | null | undefined, currency: string | null | undefined) {
  if (amount == null) return null;
  return money(amount, currency ?? "JMD");
}

export function feeToMinor(major: number, currency: string): number {
  return minorOf(major, currency);
}

export type ZoneRow = {
  id: string;
  name: string;
  slug: string;
  parish: string | null;
  geometry: unknown;
  baseFee: number;
  feeCurrency: string;
  perKmFee: number | null;
  active: boolean;
  version: number;
};

export function zoneToDto(z: ZoneRow): ZoneDto {
  return {
    id: z.id,
    name: z.name,
    slug: z.slug,
    parish: z.parish,
    geometry: z.geometry as ZoneDto["geometry"],
    baseFee: money(z.baseFee, z.feeCurrency),
    perKmFee: z.perKmFee != null ? money(z.perKmFee, z.feeCurrency) : null,
    active: z.active,
    version: z.version,
  };
}

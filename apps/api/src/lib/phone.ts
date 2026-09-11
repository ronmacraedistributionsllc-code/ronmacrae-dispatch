import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Real phone normalization (Stage 23), via libphonenumber-js — replaces the
 * hand-rolled, explicitly-provisional Jamaica-only regex this file carried
 * through Stage 22. Defaults to Jamaica when the input carries no country
 * code of its own, but correctly handles any other country's number too
 * (a customer visiting from abroad, a business with an overseas contact,
 * etc.) rather than assuming everything is Jamaican.
 *
 * This is deliberately separate from — and does not replace — the older,
 * different-shaped ad-hoc normalizer in modules/auth.ts (used for
 * User/Rider/Customer.phone *storage*, login-by-phone lookup, and the
 * per-business uniqueness key). Unifying those is a real, known follow-up
 * (flagged, not attempted here) — this file only powers the NEW
 * cross-business CustomerIdentity matching added in Stage 23, computed
 * fresh from the raw phone at write time, never from the legacy stored
 * format. Consolidating the two risks regressing login and existing
 * per-business phone storage for a cleanup that isn't this stage's job.
 */

/**
 * Canonical E.164 form (e.g. "+18765551234"), or null if the input can't be
 * confidently parsed as a valid number. Matching is intentionally strict —
 * a normalization miss means a customer's package just doesn't show up
 * grouped with their others (safe), never a wrong match between two
 * different people (unsafe).
 */
export function normalizePhone(raw: string, defaultCountry: "JM" = "JM"): string | null {
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

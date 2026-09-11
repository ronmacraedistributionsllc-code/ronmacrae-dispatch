/**
 * Minimal, provisional phone normalization — Jamaica-default only.
 *
 * This exists purely to unblock Stage 22's cross-business customer-dashboard
 * phone lookup with an honest, bounded implementation now. Stage 23 (spec
 * section 6, "global customer identity") replaces this with a proper
 * libphonenumber-based normalizer shared across the whole customer-identity
 * system, verified-vs-provisional records, and a real duplicate-resolution
 * audit trail. Nothing here should be treated as that system arriving early —
 * it is deliberately just good enough to group a customer's own packages
 * across businesses, not to merge or dedupe customer identities.
 */

/**
 * Normalizes a phone number to a canonical 10-digit Jamaica-shaped form
 * (area code + 7 digits, e.g. "8765551234"), or null if the input can't be
 * confidently normalized this way (wrong length, non-JM country code, etc).
 * Matching is intentionally exact/strict — a normalization miss means a
 * package silently doesn't show up on the dashboard, which is a safer
 * failure mode than over-matching two different people's numbers together.
 */
export function normalizePhoneJM(raw: string): string | null {
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return null;
  let d = digits;
  // NANP with a leading "1" (e.g. "18765551234") -> drop the country code.
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  // Bare 7-digit local number -> default to Jamaica's area code.
  if (d.length === 7) d = `876${d}`;
  if (d.length !== 10) return null;
  return d;
}

/** "to" address for the notification provider, matching the "+8765551234"
 *  shape already used elsewhere in this codebase (see OutboundMessage's
 *  own doc comment) — not strict E.164, kept consistent with precedent. */
export function toNotifyAddress(normalized: string): string {
  return `+${normalized}`;
}

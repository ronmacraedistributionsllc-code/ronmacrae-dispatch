/**
 * Safe email normalization (Stage 23) — deliberately conservative: trim and
 * lowercase only. No provider-specific canonicalization (Gmail's dot- and
 * plus-address folding, etc.) — that kind of rewriting genuinely helps spam
 * filters, but here it would risk treating two different people's real
 * addresses as "the same," which is exactly the wrong direction for a
 * system whose whole design principle is that a miss is safe and a wrong
 * match isn't. Email is only ever a duplicate-resolution *candidate*
 * signal (see CustomerIdentity.normalizedEmail) — never grounds to
 * auto-merge two identities on its own.
 */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  // Minimal shape check — enough to reject obvious garbage, not a full
  // RFC 5322 validator (the same standard this codebase already applies
  // via zod's z.string().email() on user-facing forms elsewhere).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

import { createHash, randomInt } from "node:crypto";

/**
 * Shared shape for every short-lived, single-use verification code in this
 * app — the phone-OTP customer-dashboard flow (Stage 22) and the email
 * verification/password-reset codes (Stage 25) both use these. Storage
 * (which Prisma model, which target field) stays per-caller, since the
 * two channels' rows differ enough (phone vs. email, no "purpose" on the
 * phone one) that a forced shared table isn't worth the abstraction.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const REQUEST_COOLDOWN_MS = 30_000;
export const MAX_VERIFY_ATTEMPTS = 5;

/** Salted with the target (phone or email) so the same 6-digit code never
 *  hashes identically across two different people's codes. */
export function hashVerificationCode(target: string, code: string): string {
  return createHash("sha256").update(`${target}:${code}`).digest("hex");
}

export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

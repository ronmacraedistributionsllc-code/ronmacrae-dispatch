import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./password.js";

/** Minimal RFC 6238 TOTP implementation (no external dependency). */

export function base32Encode(buf: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]!;
  return output;
}

export function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const raw of input.toUpperCase().replace(/[\s=-]/g, "")) {
    const idx = alphabet.indexOf(raw);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, timestampMs: number, periodS = 30, digits = 6): string {
  const key = base32Decode(secret);
  const counter = Math.floor(timestampMs / 1000 / periodS);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

/** Accepts codes for the previous, current, or next period window. */
export function verifyTotp(secret: string, code: string, nowMs = Date.now(), periodS = 30): boolean {
  const clean = code.replace(/\D/g, "");
  if (clean.length < 6) return false;
  for (const skew of [-1, 0, 1]) {
    if (safeEqual(totpCode(secret, nowMs + skew * periodS * 1000, periodS), clean)) return true;
  }
  return false;
}

/** otpauth:// URI for scanning with an authenticator app. */
export function totpUri(secret: string, account: string, issuer = "Ronmacrae Dispatch"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

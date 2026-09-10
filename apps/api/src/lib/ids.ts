import { randomBytes } from "node:crypto";

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function fromRandom(bytes: Buffer, length: number, alphabet: string): string {
  let out = "";
  let i = 0;
  while (out.length < length) {
    if (i >= bytes.length) bytes = randomBytes(32);
    const c = alphabet[bytes[i++]! % alphabet.length]!;
    if (c) out += c;
  }
  return out;
}

/** URL-safe opaque token (tracking links, proof URLs). */
export function randomToken(bytes = 24): string {
  return fromRandom(randomBytes(bytes), Math.floor(bytes * 1.3), B62);
}

/** Numeric delivery PIN. */
export function deliveryPin(length = 4): string {
  let out = "";
  while (out.length < length) out += String(randomBytes(1)[0]! % 10);
  return out;
}

/** cuid-ish unique id for client-generated values. */
export function uid(): string {
  return randomBytes(12).toString("hex");
}

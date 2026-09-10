import { describe, expect, it } from "vitest";
import { generateTotpSecret, totpCode, verifyTotp, totpUri, base32Decode, base32Encode } from "../src/lib/totp.js";
import { randomBytes } from "node:crypto";

/** RFC 6238 appendix D secret ("Hello!..." in ASCII) */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("matches the RFC 6238 appendix B SHA1/30s/6-digit vectors", () => {
    // 8-digit RFC values: 94287082 / 07081804 / 89005924 / 69279037
    expect(totpCode(RFC_SECRET, 59_000)).toBe("287082");
    expect(totpCode(RFC_SECRET, 1_111_111_109_000)).toBe("081804");
    expect(totpCode(RFC_SECRET, 1_234_567_890_000)).toBe("005924");
    expect(totpCode(RFC_SECRET, 2_000_000_000_000)).toBe("279037");
  });

  it("verifies within the +/-1 window only", () => {
    const now = 59_000;
    const code = totpCode(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now + 2 * 30_000)).toBe(false);
  });

  it("generates decodable secrets and otpauth URIs", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    const uri = totpUri(secret, "admin@example.com");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(`secret=${secret}`);
  });
});

describe("base32", () => {
  it("round-trips arbitrary buffers", () => {
    for (const len of [1, 15, 16, 20, 31, 32, 64]) {
      const buf = randomBytes(len);
      expect(base32Decode(base32Encode(buf))).toEqual(buf);
    }
  });
});

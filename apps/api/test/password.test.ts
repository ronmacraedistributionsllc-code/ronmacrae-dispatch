import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, safeEqual } from "../src/lib/password.js";
import { hashToken, newJti } from "../src/lib/jwt.js";

describe("password", () => {
  it("hashes and verifies", () => {
    const hash = hashPassword("s3cret-Passw0rd");
    expect(hash).toMatch(/^s1:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(verifyPassword("s3cret-Passw0rd", hash)).toBe(true);
    expect(verifyPassword("wrong", hash)).toBe(false);
  });

  it("produces unique salts", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored hashes", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("safeEqual", () => {
  it("compares only equal-length strings", () => {
    expect(safeEqual("1234", "1234")).toBe(true);
    expect(safeEqual("1234", "1235")).toBe(false);
    expect(safeEqual("123", "1234")).toBe(false);
  });
});

describe("refresh token hashing", () => {
  it("hashes to a stable sha256 form", () => {
    const h = hashToken("token-value");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashToken("token-value")).toBe(h);
    expect(newJti()).toHaveLength(32);
  });
});

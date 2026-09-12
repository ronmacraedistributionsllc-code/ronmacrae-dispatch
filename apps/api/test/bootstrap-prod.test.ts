/**
 * Regression test for the null-password crash: `bootstrapProduction` used
 * to build its `upsert`'s `create` object eagerly, which called
 * `hashPassword(password!)` even on the update path — where `password` was
 * really `null` at runtime (the `!` only silences TypeScript, it doesn't
 * change the value) — crashing with "the password argument must be of
 * type string" every time it ran against an already-bootstrapped database.
 */
import { describe, expect, it } from "vitest";
import { buildTestHarness } from "./helpers/test-app.js";
import { bootstrapProduction, ADMIN_EMAIL } from "../src/bootstrap-prod.js";
import { verifyPassword } from "../src/lib/password.js";

const cfg = { operationalCurrency: "JMD", usdToJmdRate: 155, pinLength: 4, trackingLinkTtlHours: 72 };

// Each test gets its own fresh db (ADMIN_EMAIL/the "ronmacrae" slug are fixed
// constants, not per-test-unique, so tests must not share a database or the
// "does not exist yet" case would only ever be exercised once).
describe("bootstrapProduction", () => {
  it("creates the business and one admin login when neither exists yet", async () => {
    const harness = await buildTestHarness("test-bootstrap-prod-fresh");
    try {
      const result = await bootstrapProduction(harness.prisma, cfg);
      expect(result.generatedPassword).not.toBeNull();

      const business = await harness.prisma.business.findUnique({ where: { id: result.businessId } });
      expect(business?.slug).toBe("ronmacrae");

      const user = await harness.prisma.user.findUnique({ where: { id: result.userId } });
      expect(user?.email).toBe(ADMIN_EMAIL);
      expect(user?.role).toBe("admin");
      expect(verifyPassword(result.generatedPassword!, user!.passwordHash!)).toBe(true);

      const membership = await harness.prisma.staffMembership.findUnique({
        where: { userId_businessId: { userId: result.userId, businessId: result.businessId } },
      });
      expect(membership?.active).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("re-running against an already-bootstrapped database does not crash, and never touches the existing password", async () => {
    const harness = await buildTestHarness("test-bootstrap-prod-rerun");
    try {
      const first = await bootstrapProduction(harness.prisma, cfg);
      expect(first.generatedPassword).not.toBeNull();
      const before = await harness.prisma.user.findUniqueOrThrow({ where: { id: first.userId } });

      // This is the exact call that used to throw
      // "TypeError [ERR_INVALID_ARG_TYPE]: The 'password' argument must be
      // of type string" — hashPassword(null) on the update path.
      const second = await bootstrapProduction(harness.prisma, cfg);

      expect(second.generatedPassword).toBeNull();
      expect(second.userId).toBe(first.userId);
      expect(second.businessId).toBe(first.businessId);

      const after = await harness.prisma.user.findUniqueOrThrow({ where: { id: second.userId } });
      expect(after.passwordHash).toBe(before.passwordHash);
      // the original generated password still works against the untouched hash
      expect(verifyPassword(first.generatedPassword!, after.passwordHash!)).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
});

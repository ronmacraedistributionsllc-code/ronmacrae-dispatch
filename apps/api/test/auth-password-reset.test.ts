/**
 * Public password reset for the shared login (staff, riders, anyone with
 * a User email). Real Fastify app + real sqlite db (see
 * test/helpers/test-app.ts).
 *
 * The plaintext code is never returned by any API response — tests read
 * it off the memory email provider's own `sent` log
 * (`harness.ctx.email`), the same way a real inbox would have shown it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MemoryEmailProvider } from "@ronmacrae/notifications";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;
const freshEmail = () => `staff-${uniq()}@example.com`;

function emailProvider(): MemoryEmailProvider {
  return harness.ctx.email as MemoryEmailProvider;
}

function latestResetCode(email: string): string {
  const sent = [...emailProvider().sent].reverse().find((m) => m.to === email && m.subject === "Reset your password");
  if (!sent) throw new Error(`no reset email sent to ${email}`);
  const match = /code is (\d{6})/.exec(sent.text);
  if (!match) throw new Error(`could not find a code in: ${sent.text}`);
  return match[1]!;
}

async function makeStaff(email: string, active = true) {
  return harness.prisma.user.create({
    data: { name: "Dana Dispatcher", email, passwordHash: hashPassword("old-password-1"), role: "dispatcher", active },
  });
}

beforeAll(async () => {
  harness = await buildTestHarness("test-auth-password-reset");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("POST /api/auth/request-password-reset", () => {
  it("always returns ok, even for an unknown email — and sends nothing", async () => {
    const before = emailProvider().sent.length;
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/auth/request-password-reset",
      payload: { email: freshEmail() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(emailProvider().sent.length).toBe(before);
  });

  it("sends a code for a known email", async () => {
    const email = freshEmail();
    await makeStaff(email);
    const res = await harness.app.inject({ method: "POST", url: "/api/auth/request-password-reset", payload: { email } });
    expect(res.statusCode).toBe(200);
    expect(latestResetCode(email)).toMatch(/^\d{6}$/);
  });

  it("rejects a malformed body", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/api/auth/request-password-reset", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("rejects a wrong code and leaves the password alone", async () => {
    const email = freshEmail();
    await makeStaff(email);
    await harness.app.inject({ method: "POST", url: "/api/auth/request-password-reset", payload: { email } });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { email, code: "000000", newPassword: "new-password-1" },
    });
    expect(res.statusCode).toBe(400);
    const row = await harness.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(verifyPassword("old-password-1", row.passwordHash)).toBe(true);
  });

  it("resets with the right code, kills every session, and audits", async () => {
    const email = freshEmail();
    const user = await makeStaff(email);
    // A live session that must die with the reset.
    await harness.prisma.session.create({ data: { id: `sess-${uniq()}`, userId: user.id, tokenHash: "sha256:deadbeef", expiresAt: new Date(Date.now() + 3600_000) } });
    await harness.app.inject({ method: "POST", url: "/api/auth/request-password-reset", payload: { email } });

    const res = await harness.app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { email, code: latestResetCode(email), newPassword: "brand-new-password-1" },
    });
    expect(res.statusCode).toBe(200);
    const row = await harness.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(verifyPassword("brand-new-password-1", row.passwordHash)).toBe(true);
    expect(verifyPassword("old-password-1", row.passwordHash)).toBe(false);
    expect(await harness.prisma.session.count({ where: { userId: user.id } })).toBe(0);
    const audit = await harness.prisma.auditLog.findFirst({ where: { action: "auth.password_reset", entityId: user.id }, orderBy: { at: "desc" } });
    expect(audit).not.toBeNull();
  });

  it("a used code cannot be redeemed twice", async () => {
    const email = freshEmail();
    await makeStaff(email);
    await harness.app.inject({ method: "POST", url: "/api/auth/request-password-reset", payload: { email } });
    const code = latestResetCode(email);
    const first = await harness.app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { email, code, newPassword: "brand-new-password-2" } });
    expect(first.statusCode).toBe(200);
    const second = await harness.app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { email, code, newPassword: "another-password-3" } });
    expect(second.statusCode).toBe(400);
  });

  it("refuses disabled accounts and validates the new password", async () => {
    const email = freshEmail();
    await makeStaff(email, false);
    await harness.app.inject({ method: "POST", url: "/api/auth/request-password-reset", payload: { email } });
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { email, code: latestResetCode(email), newPassword: "brand-new-password-1" },
    });
    expect(res.statusCode).toBe(404);

    const short = await harness.app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { email, code: "123456", newPassword: "short" },
    });
    expect(short.statusCode).toBe(400);
  });
});

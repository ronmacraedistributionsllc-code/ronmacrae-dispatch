/**
 * Customer account-claim / sign-in (Stage 25 / spec 7): optional email+
 * password on top of an already phone-verified CustomerIdentity. Real
 * Fastify app + real sqlite db (see test/helpers/test-app.ts).
 *
 * The plaintext email code is never returned by any API response — tests
 * read it off the memory email provider's own `sent` log
 * (`harness.ctx.email`), the same way a real inbox would have shown it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MemoryEmailProvider } from "@ronmacrae/notifications";
import { buildTestHarness, type TestHarness } from "./helpers/test-app.js";
import { normalizePhone } from "../src/lib/phone.js";

let harness: TestHarness;
let seq = 0;
const uniq = () => `${Date.now()}${++seq}`;
const freshPhone = () => `876${uniq().slice(-7)}`;
const freshEmail = () => `person-${uniq()}@example.com`;

function emailProvider(): MemoryEmailProvider {
  return harness.ctx.email as MemoryEmailProvider;
}

/** Latest code sent for a given email + subject (distinguishes
 *  verify-email from password-reset codes, which share no other marker). */
function latestEmailCode(email: string, subject: string): string {
  const sent = [...emailProvider().sent].reverse().find((m) => m.to === email && m.subject === subject);
  if (!sent) throw new Error(`no email sent to ${email} with subject "${subject}"`);
  const match = /code is (\d{6})/.exec(sent.text);
  if (!match) throw new Error(`could not find a code in: ${sent.text}`);
  return match[1]!;
}

async function dashboardTokenFor(rawPhone: string): Promise<string> {
  const phone = normalizePhone(rawPhone)!;
  await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/request-code", payload: { phone: rawPhone } });
  const row = await harness.prisma.outboxMessage.findFirst({ where: { template: "customer_dashboard_code", to: phone }, orderBy: { createdAt: "desc" } });
  const code = (row!.params as { code: string }).code;
  const res = await harness.app.inject({ method: "POST", url: "/api/customer-dashboard/verify", payload: { phone: rawPhone, code } });
  return (res.json() as { token: string }).token;
}

beforeAll(async () => {
  harness = await buildTestHarness("test-customer-account");
});

afterAll(async () => {
  await harness.cleanup();
});

describe("claiming an account requires an already phone-verified session", () => {
  it("rejects claim with no Bearer token at all", async () => {
    const res = await harness.app.inject({ method: "POST", url: "/api/customer-account/claim", payload: { email: freshEmail(), password: "correcthorsebattery" } });
    expect(res.statusCode).toBe(401);
  });

  it("a valid dashboard session can claim an account, which then requires email verification", async () => {
    const phone = freshPhone();
    const token = await dashboardTokenFor(phone);
    const email = freshEmail();

    const claim = await harness.app.inject({ method: "POST", url: "/api/customer-account/claim", headers: { authorization: `Bearer ${token}` }, payload: { email, password: "correcthorsebattery" } });
    expect(claim.statusCode).toBe(200);

    const status = await harness.app.inject({ method: "GET", url: "/api/customer-account/status", headers: { authorization: `Bearer ${token}` } });
    const statusBody = status.json() as { hasAccount: boolean; email: string; emailVerified: boolean };
    expect(statusBody.hasAccount).toBe(true);
    expect(statusBody.email).toBe(email);
    expect(statusBody.emailVerified).toBe(false);

    const code = latestEmailCode(email, "Verify your email");
    const verify = await harness.app.inject({ method: "POST", url: "/api/customer-account/verify-email", payload: { email, code } });
    expect(verify.statusCode).toBe(200);

    const statusAfter = await harness.app.inject({ method: "GET", url: "/api/customer-account/status", headers: { authorization: `Bearer ${token}` } });
    expect((statusAfter.json() as { emailVerified: boolean }).emailVerified).toBe(true);
  });

  it("refuses a second account for the same phone, and a duplicate email", async () => {
    const phone = freshPhone();
    const token = await dashboardTokenFor(phone);
    const email = freshEmail();
    await harness.app.inject({ method: "POST", url: "/api/customer-account/claim", headers: { authorization: `Bearer ${token}` }, payload: { email, password: "correcthorsebattery" } });

    const again = await harness.app.inject({ method: "POST", url: "/api/customer-account/claim", headers: { authorization: `Bearer ${token}` }, payload: { email: freshEmail(), password: "correcthorsebattery" } });
    expect(again.statusCode).toBe(409);

    const otherPhone = freshPhone();
    const otherToken = await dashboardTokenFor(otherPhone);
    const sameEmail = await harness.app.inject({ method: "POST", url: "/api/customer-account/claim", headers: { authorization: `Bearer ${otherToken}` }, payload: { email, password: "differentpassword1" } });
    expect(sameEmail.statusCode).toBe(409);
  });
});

describe("email verification codes", () => {
  it("rejects a wrong code without consuming a correct one, and enforces a resend cooldown", async () => {
    const phone = freshPhone();
    const token = await dashboardTokenFor(phone);
    const email = freshEmail();
    await harness.app.inject({ method: "POST", url: "/api/customer-account/claim", headers: { authorization: `Bearer ${token}` }, payload: { email, password: "correcthorsebattery" } });

    const resend = await harness.app.inject({ method: "POST", url: "/api/customer-account/resend-verification", headers: { authorization: `Bearer ${token}` } });
    expect(resend.statusCode).toBe(429); // cooldown from claim's own send

    const wrong = await harness.app.inject({ method: "POST", url: "/api/customer-account/verify-email", payload: { email, code: "000000" } });
    expect(wrong.statusCode).toBe(400);

    const code = latestEmailCode(email, "Verify your email");
    const right = await harness.app.inject({ method: "POST", url: "/api/customer-account/verify-email", payload: { email, code } });
    expect(right.statusCode).toBe(200);

    // Already consumed — using it again fails even though it was correct.
    const reuse = await harness.app.inject({ method: "POST", url: "/api/customer-account/verify-email", payload: { email, code } });
    expect(reuse.statusCode).toBe(400);
  });
});

describe("login", () => {
  it("logs in with the right credentials and gives a real, working dashboard session", async () => {
    const phone = freshPhone();
    const token = await dashboardTokenFor(phone);
    const email = freshEmail();
    await harness.app.inject({ method: "POST", url: "/api/customer-account/claim", headers: { authorization: `Bearer ${token}` }, payload: { email, password: "correcthorsebattery" } });

    const login = await harness.app.inject({ method: "POST", url: "/api/customer-account/login", payload: { email, password: "correcthorsebattery" } });
    expect(login.statusCode).toBe(200);
    const loginToken = (login.json() as { token: string }).token;

    // The account-issued token works exactly like the OTP-issued one.
    const dashboard = await harness.app.inject({ method: "GET", url: "/api/customer-dashboard", headers: { authorization: `Bearer ${loginToken}` } });
    expect(dashboard.statusCode).toBe(200);
  });

  it("gives the exact same generic error for a wrong password and for an email with no account", async () => {
    const phone = freshPhone();
    const token = await dashboardTokenFor(phone);
    const email = freshEmail();
    await harness.app.inject({ method: "POST", url: "/api/customer-account/claim", headers: { authorization: `Bearer ${token}` }, payload: { email, password: "correcthorsebattery" } });

    const wrongPassword = await harness.app.inject({ method: "POST", url: "/api/customer-account/login", payload: { email, password: "wrongpassword1" } });
    const noSuchAccount = await harness.app.inject({ method: "POST", url: "/api/customer-account/login", payload: { email: freshEmail(), password: "wrongpassword1" } });
    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchAccount.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(noSuchAccount.json());
  });
});

describe("password reset", () => {
  it("resets the password via an emailed code, and the old password stops working", async () => {
    const phone = freshPhone();
    const token = await dashboardTokenFor(phone);
    const email = freshEmail();
    await harness.app.inject({ method: "POST", url: "/api/customer-account/claim", headers: { authorization: `Bearer ${token}` }, payload: { email, password: "correcthorsebattery" } });

    const request = await harness.app.inject({ method: "POST", url: "/api/customer-account/request-password-reset", payload: { email } });
    expect(request.statusCode).toBe(200);
    const code = latestEmailCode(email, "Reset your password");

    const reset = await harness.app.inject({ method: "POST", url: "/api/customer-account/reset-password", payload: { email, code, newPassword: "brandnewpassword2" } });
    expect(reset.statusCode).toBe(200);

    const oldLogin = await harness.app.inject({ method: "POST", url: "/api/customer-account/login", payload: { email, password: "correcthorsebattery" } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await harness.app.inject({ method: "POST", url: "/api/customer-account/login", payload: { email, password: "brandnewpassword2" } });
    expect(newLogin.statusCode).toBe(200);
  });

  it("never reveals whether an email has an account — always 200, and never actually sends for an unknown email", async () => {
    const unknownEmail = freshEmail();
    const before = emailProvider().sent.length;
    const res = await harness.app.inject({ method: "POST", url: "/api/customer-account/request-password-reset", payload: { email: unknownEmail } });
    expect(res.statusCode).toBe(200);
    expect(emailProvider().sent.length).toBe(before); // nothing actually sent
  });
});

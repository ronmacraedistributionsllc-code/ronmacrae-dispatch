import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { normalizeEmail } from "../lib/email.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { CODE_TTL_MS, REQUEST_COOLDOWN_MS, MAX_VERIFY_ATTEMPTS, hashVerificationCode, generateVerificationCode } from "../lib/verification-code.js";
import { CUSTOMER_DASHBOARD_TTL_S } from "../lib/jwt.js";

/**
 * Customer account-claim / sign-in (Stage 25, spec section 7) — email +
 * password as an OPTIONAL, ADDITIVE upgrade on top of an already-
 * established, phone-verified CustomerIdentity (Stage 22/23). The
 * phone-OTP dashboard flow stays available regardless of whether an
 * account exists; this never replaces it, only adds a second way in that
 * doesn't need a fresh SMS every visit.
 *
 * "Claiming" an account requires already holding a valid customer-
 * dashboard session token (proof of phone ownership from Stage 22) — so
 * creating credentials can never itself be used to take over somebody
 * else's identity by guessing an email. Login afterward issues that exact
 * same kind of token (CustomerDashboardTokenPayload), scoped to the
 * account's own identity, so every existing dashboard route keeps working
 * unchanged for an account-based session.
 *
 * No billing anywhere in this flow (not requested for this stage).
 */

const EmailSchema = z.string().trim().email().max(200);
const PasswordSchema = z.string().min(8).max(128);

async function requireCustomerDashboardPhone(ctx: AppCtx, req: FastifyRequest): Promise<string> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw httpErrors.createError(401, "Sign in to your packages dashboard first.");
  const payload = await ctx.jwt.verifyCustomerDashboard(token);
  if (!payload) throw httpErrors.createError(401, "Your session has expired — sign in again.");
  return payload.phone;
}

async function requireIdentityIdForPhone(ctx: AppCtx, phone: string): Promise<string> {
  const identity = await ctx.prisma.customerIdentity.findUnique({ where: { normalizedPhone: phone }, select: { id: true } });
  // A dashboard token can only ever be issued for a phone that's already
  // gone through the identity system (see customer-dashboard.ts's
  // verify() route, which creates the identity as a side effect of a
  // correct code) — this should be unreachable in practice.
  if (!identity) throw httpErrors.createError(409, "Verify your phone again before creating an account.");
  return identity.id;
}

/** Reused outside this module too (riders.ts's public self-signup) — the
 *  backing table (CustomerEmailCode) is generic (email + purpose + code),
 *  not actually tied to CustomerAccount by any foreign key, despite its
 *  name. `purpose` is a free string on purpose (heh) — add a new one per
 *  use case rather than widening this union forever. */
export async function sendEmailCode(ctx: AppCtx, email: string, purpose: string, subject: string, bodyFor: (code: string) => string): Promise<void> {
  const recent = await ctx.prisma.customerEmailCode.findFirst({ where: { email, purpose }, orderBy: { createdAt: "desc" } });
  if (recent && Date.now() - recent.createdAt.getTime() < REQUEST_COOLDOWN_MS) {
    throw httpErrors.createError(429, "Please wait a moment before requesting another code.");
  }
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const row = await ctx.prisma.customerEmailCode.create({ data: { email, purpose, codeHash: hashVerificationCode(email, code), expiresAt } });
  const result = await ctx.email.send({ to: email, subject, text: bodyFor(code) });
  if (result.status === "failed") {
    // Never leave a row behind for a code that was never actually sent — it
    // would otherwise (a) wrongly block an immediate retry behind the
    // cooldown check above, since that check only looks at *whether* a row
    // exists, never whether it was ever delivered, and (b) sit as a
    // guessable, never-delivered code with nobody who could type it in.
    await ctx.prisma.customerEmailCode.delete({ where: { id: row.id } }).catch(() => undefined);
    // The provider's own error (never the code itself — that never appears
    // in a log line) is exactly what tells a real diagnosis apart from a
    // guess: an unverified sending domain, a bad API key, and a network
    // timeout all produce a different `result.error` here.
    ctx.log.error({ email, purpose, provider: ctx.email.name, error: result.error }, "verification email failed to send");
    throw httpErrors.createError(502, "We couldn't send your verification email right now — please try again in a moment.");
  }
}

export async function consumeEmailCode(ctx: AppCtx, email: string, purpose: string, code: string): Promise<void> {
  const row = await ctx.prisma.customerEmailCode.findFirst({ where: { email, purpose, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
  if (!row) throw httpErrors.createError(400, "That code has expired or wasn't found — request a new one.");
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    await ctx.prisma.customerEmailCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    throw httpErrors.createError(400, "Too many attempts — request a new code.");
  }
  if (row.codeHash !== hashVerificationCode(email, code.trim())) {
    await ctx.prisma.customerEmailCode.update({ where: { id: row.id }, data: { attempts: row.attempts + 1 } });
    throw httpErrors.createError(400, "Incorrect code.");
  }
  await ctx.prisma.customerEmailCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
}

const ClaimBody = z.object({ email: EmailSchema, password: PasswordSchema });
const VerifyEmailBody = z.object({ email: EmailSchema, code: z.string().min(4).max(10) });
const LoginBody = z.object({ email: EmailSchema, password: z.string().min(1).max(128) });
const RequestResetBody = z.object({ email: EmailSchema });
const ResetPasswordBody = z.object({ email: EmailSchema, code: z.string().min(4).max(10), newPassword: PasswordSchema });

export async function customerAccountRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/customer-account/status", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const phone = await requireCustomerDashboardPhone(ctx, req);
    const identity = await ctx.prisma.customerIdentity.findUnique({ where: { normalizedPhone: phone }, select: { account: { select: { email: true, emailVerifiedAt: true } } } });
    const account = identity?.account ?? null;
    return { hasAccount: Boolean(account), email: account?.email ?? null, emailVerified: Boolean(account?.emailVerifiedAt) };
  });

  app.post("/api/customer-account/claim", async (req) => {
    const phone = await requireCustomerDashboardPhone(ctx, req);
    const identityId = await requireIdentityIdForPhone(ctx, phone);
    const body = ClaimBody.parse(req.body);
    const email = normalizeEmail(body.email);
    if (!email) throw httpErrors.createError(400, "Enter a valid email address.");

    const existingForIdentity = await ctx.prisma.customerAccount.findUnique({ where: { identityId } });
    if (existingForIdentity) throw httpErrors.createError(409, "This phone number already has an account.");
    const existingForEmail = await ctx.prisma.customerAccount.findUnique({ where: { email } });
    if (existingForEmail) throw httpErrors.createError(409, "That email address is already in use.");

    await ctx.prisma.customerAccount.create({ data: { identityId, email, passwordHash: hashPassword(body.password) } });
    await sendEmailCode(ctx, email, "verify_email", "Verify your email", (code) => `Your verification code is ${code}. It expires in 10 minutes.`);
    return { ok: true };
  });

  app.post("/api/customer-account/resend-verification", async (req) => {
    const phone = await requireCustomerDashboardPhone(ctx, req);
    const identityId = await requireIdentityIdForPhone(ctx, phone);
    const account = await ctx.prisma.customerAccount.findUnique({ where: { identityId } });
    if (!account) throw httpErrors.createError(404, "No account found for this phone number.");
    if (account.emailVerifiedAt) return { ok: true, alreadyVerified: true };
    await sendEmailCode(ctx, account.email, "verify_email", "Verify your email", (code) => `Your verification code is ${code}. It expires in 10 minutes.`);
    return { ok: true };
  });

  app.post("/api/customer-account/verify-email", async (req) => {
    const body = VerifyEmailBody.parse(req.body);
    const email = normalizeEmail(body.email);
    if (!email) throw httpErrors.createError(400, "Enter a valid email address.");
    await consumeEmailCode(ctx, email, "verify_email", body.code);
    await ctx.prisma.customerAccount.updateMany({ where: { email }, data: { emailVerifiedAt: new Date() } });
    return { ok: true };
  });

  app.post("/api/customer-account/login", async (req) => {
    const body = LoginBody.parse(req.body);
    const email = normalizeEmail(body.email);
    const genericError = () => httpErrors.createError(401, "Incorrect email or password.");
    if (!email) throw genericError();
    const account = await ctx.prisma.customerAccount.findUnique({ where: { email }, include: { identity: { select: { normalizedPhone: true } } } });
    // Never distinguish "no such account" from "wrong password" — both are
    // the same generic message, so a login attempt can't be used to probe
    // which emails have accounts.
    if (!account || !verifyPassword(body.password, account.passwordHash)) throw genericError();
    const token = await ctx.jwt.issueCustomerDashboard(account.identity.normalizedPhone);
    return { token, expiresInSeconds: CUSTOMER_DASHBOARD_TTL_S };
  });

  app.post("/api/customer-account/request-password-reset", async (req) => {
    const body = RequestResetBody.parse(req.body);
    const email = normalizeEmail(body.email);
    // Always looks like success — never reveal whether this email has an
    // account (the same anti-enumeration stance as everywhere else this
    // codebase touches auth/identity).
    if (email) {
      const account = await ctx.prisma.customerAccount.findUnique({ where: { email }, select: { email: true } });
      if (account) {
        await sendEmailCode(ctx, email, "password_reset", "Reset your password", (code) => `Your password reset code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`).catch(() => undefined);
      }
    }
    return { ok: true };
  });

  app.post("/api/customer-account/reset-password", async (req) => {
    const body = ResetPasswordBody.parse(req.body);
    const email = normalizeEmail(body.email);
    if (!email) throw httpErrors.createError(400, "Enter a valid email address.");
    await consumeEmailCode(ctx, email, "password_reset", body.code);
    const updated = await ctx.prisma.customerAccount.updateMany({ where: { email }, data: { passwordHash: hashPassword(body.newPassword) } });
    if (updated.count === 0) throw httpErrors.createError(404, "No account found for this email address.");
    return { ok: true };
  });
}

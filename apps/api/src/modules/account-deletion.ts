import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { verifyPassword } from "../lib/password.js";
import { ACTIVE_JOB_STATUSES } from "@ronmacrae/contracts";

/**
 * Self-service account deletion (store-review requirement: an app that lets
 * people create an account must let them delete it from inside the app).
 *
 * Deliberately a SOFT delete, reusing the exact same `User.deletedAt` +
 * `active:false` pair platform-owner deletion already sets — login refuses a
 * deleted user on every face (auth.ts, merchant-portal.ts, logistics-portal.ts)
 * with its own "Account deleted" message. Jobs, ratings, COD events,
 * settlements and audit rows all reference the User/Rider and must keep
 * rendering (a standing product rule: "account deletion should preserve
 * historical order/audit integrity"), so nothing they point at is removed.
 * What IS removed is what makes the person reachable or able to act: their
 * sessions and push subscriptions, and every access flag (memberships,
 * portal logins, rider availability).
 *
 * Re-authentication (current password) is required — a stolen session alone
 * must not be able to erase an account ("sensitive account changes require
 * verification"). An admin impersonating someone must never be able to use
 * this, so the impersonation token is refused outright.
 */

const DeleteBody = z.object({ password: z.string().min(1).max(128) });

/** Refusals are 409 (not 400/403): the request is valid, the account is
 *  just in a state where deleting it now would strand something real. */
async function assertSafeToDelete(ctx: AppCtx, user: { id: string; platformRole: string | null; rider: { id: string } | null }): Promise<void> {
  // The network's owner is removed by a deliberate manual action, never by
  // a self-service click.
  if (user.platformRole === "owner") {
    throw httpErrors.createError(409, "A platform owner account can't be deleted from here. Contact support to hand over ownership first.");
  }

  // Never orphan a business: if this person is the only remaining active
  // admin of one, someone else has to be made admin first.
  const adminMemberships = await ctx.prisma.staffMembership.findMany({
    where: { userId: user.id, role: "admin", active: true },
    include: { business: { select: { id: true, name: true } } },
  });
  const orphaned: string[] = [];
  for (const m of adminMemberships) {
    const otherAdmins = await ctx.prisma.staffMembership.count({
      where: { businessId: m.businessId, role: "admin", active: true, userId: { not: user.id }, user: { active: true, deletedAt: null } },
    });
    if (otherAdmins === 0) orphaned.push(m.business.name);
  }
  if (orphaned.length > 0) {
    throw httpErrors.createError(409, `You're the only admin of ${orphaned.join(", ")}. Make someone else an admin first, then delete your account.`);
  }

  if (user.rider) {
    const activeJobs = await ctx.prisma.job.count({ where: { riderId: user.rider.id, status: { in: [...ACTIVE_JOB_STATUSES] } } });
    if (activeJobs > 0) {
      throw httpErrors.createError(409, `You have ${activeJobs} delivery in progress. Finish or hand it back to dispatch before deleting your account.`);
    }
    // Cash a courier is holding or that's still being reconciled is an
    // obligation to the business — deleting would hide who owes what.
    const openCash = await ctx.prisma.job.count({
      where: { riderId: user.rider.id, paymentMethod: "cod", codStatus: { in: ["collected", "handed_in", "disputed"] } },
    });
    if (openCash > 0) {
      throw httpErrors.createError(409, `You have ${openCash} cash-on-delivery order(s) not yet reconciled. Hand in the cash and have it approved first.`);
    }
  }
}

export async function deleteOwnAccount(ctx: AppCtx, userId: string, password: string): Promise<void> {
  const user = await ctx.prisma.user.findUnique({ where: { id: userId }, include: { rider: { select: { id: true } } } });
  if (!user) throw httpErrors.createError(401, "Sign in again to continue.");
  if (user.deletedAt) throw httpErrors.createError(409, "This account has already been deleted.");
  // Same generic wording whether the password is wrong or something else
  // about the request is off — nothing here confirms details to a guesser.
  if (!verifyPassword(password, user.passwordHash)) throw httpErrors.createError(403, "That password isn't correct.");

  await assertSafeToDelete(ctx, user);

  await ctx.prisma.$transaction(async (tx) => {
    // Same atomic-claim guard the rest of the platform uses, so two
    // concurrent delete requests can't both "succeed".
    const claimed = await tx.user.updateMany({ where: { id: userId, deletedAt: null }, data: { deletedAt: new Date(), active: false } });
    if (claimed.count !== 1) throw httpErrors.createError(409, "This account has already been deleted.");
    await tx.session.deleteMany({ where: { userId } });
    await tx.pushSubscription.deleteMany({ where: { userId } });
    // Access flags only — the rows (and everything that references them)
    // stay, so history keeps rendering.
    await tx.staffMembership.updateMany({ where: { userId }, data: { active: false } });
    await tx.merchantStaff.updateMany({ where: { userId }, data: { active: false } });
    await tx.logisticsCompanyStaff.updateMany({ where: { userId }, data: { active: false } });
    if (user.rider) {
      await tx.rider.update({ where: { id: user.rider.id }, data: { active: false, status: "offline" } });
    }
  });
  // Recorded after the fact and carries no credential material.
  await ctx.audit.record({ id: userId, role: user.role }, "account.self_delete", "user", userId, {});
}

export async function accountDeletionRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const limit = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };

  // Main app face (staff + couriers) — the global auth hook has already
  // verified the access token by the time this runs.
  app.post("/api/auth/delete-account", limit, async (req) => {
    if (req.user!.impersonatedBy) {
      throw httpErrors.createError(403, "An admin signed in as this person can't delete their account.");
    }
    const body = DeleteBody.parse(req.body);
    await deleteOwnAccount(ctx, req.user!.sub, body.password);
    return { ok: true };
  });

  // The merchant / logistics portals are their own auth "faces" (a
  // merchant-only person never holds a staff access token), each gated by
  // its own token type inside the handler, same as the rest of that portal.
  app.post("/api/merchant-portal/delete-account", limit, async (req) => {
    const payload = await ctx.jwt.verifyMerchantPortal(bearer(req));
    if (!payload) throw httpErrors.createError(401, "Your session has expired — sign in again.");
    await deleteOwnAccount(ctx, payload.sub, DeleteBody.parse(req.body).password);
    return { ok: true };
  });

  app.post("/api/logistics-portal/delete-account", limit, async (req) => {
    const payload = await ctx.jwt.verifyLogisticsPortal(bearer(req));
    if (!payload) throw httpErrors.createError(401, "Your session has expired — sign in again.");
    await deleteOwnAccount(ctx, payload.sub, DeleteBody.parse(req.body).password);
    return { ok: true };
  });

  // Customers: the optional email+password account on a phone-verified
  // identity. Removing it deletes the login and the email on file. The
  // delivery records themselves belong to the businesses that fulfilled
  // them (accounting, disputes, audit) and are NOT erased — the privacy
  // page says exactly this.
  app.post("/api/customer-account/delete", limit, async (req) => {
    const payload = await ctx.jwt.verifyCustomerDashboard(bearer(req));
    if (!payload) throw httpErrors.createError(401, "Your session has expired — sign in again.");
    const body = DeleteBody.parse(req.body);
    const identity = await ctx.prisma.customerIdentity.findUnique({ where: { normalizedPhone: payload.phone }, include: { account: true } });
    if (!identity?.account) throw httpErrors.createError(404, "There's no account to delete for this phone number.");
    if (!verifyPassword(body.password, identity.account.passwordHash)) throw httpErrors.createError(403, "That password isn't correct.");
    await ctx.prisma.$transaction(async (tx) => {
      await tx.customerAccount.delete({ where: { id: identity.account!.id } });
      await tx.customerIdentity.update({ where: { id: identity.id }, data: { normalizedEmail: null } });
    });
    await ctx.audit.record({ id: null, role: "customer" }, "account.self_delete", "customer_identity", identity.id, {});
    return { ok: true };
  });
}

function bearer(req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

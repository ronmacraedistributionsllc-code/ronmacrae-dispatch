import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { normalizePhone } from "../lib/phone.js";
import { normalizeEmail } from "../lib/email.js";
import type { DuplicateCandidateDto } from "@ronmacrae/contracts";

/**
 * Global customer identity (Stage 23, spec section 6) — see the
 * CustomerIdentity/MergedPhoneAlias models in schema.prisma for the data
 * model's own reasoning. This module is the only place that ever writes
 * to either table; every other call site (customers.ts, delivery.ts,
 * customer-dashboard.ts) goes through the functions here.
 */

/** Resolve a phone (+ optional email as a duplicate-candidate signal) to
 *  its CustomerIdentity id, creating one if this exact normalized phone has
 *  never been seen before — and following a merge alias if this phone was
 *  previously its own identity that later got merged into another.
 *  Deterministic and automatic; never a merge of two already-distinct
 *  identities (that stays a separate, owner-only, audited action below).
 *  Returns null only when the phone can't be confidently normalized. */
export async function resolveCustomerIdentity(
  ctx: AppCtx,
  input: { phone: string; email?: string | null },
): Promise<string | null> {
  const normalizedPhone = normalizePhone(input.phone);
  if (!normalizedPhone) return null;
  const normalizedEmail = input.email ? normalizeEmail(input.email) : null;

  const identityId = await findOrCreateIdentityId(ctx, normalizedPhone);

  // Opportunistically record a missing email as a future duplicate-
  // candidate signal — never overwrite one already on file, so one
  // business's typo can't silently replace a signal another business's
  // correct email already established.
  if (normalizedEmail) {
    const identity = await ctx.prisma.customerIdentity.findUnique({ where: { id: identityId }, select: { normalizedEmail: true } });
    if (identity && !identity.normalizedEmail) {
      await ctx.prisma.customerIdentity.update({ where: { id: identityId }, data: { normalizedEmail } });
    }
  }
  return identityId;
}

/** Opportunistically attaches an email signal to an identity that's already
 *  known by id — used when only a Customer's email changes (phone
 *  untouched), so there's no need to re-derive the identity from a phone
 *  at all. Same never-overwrite rule as resolveCustomerIdentity. */
export async function attachEmailSignal(ctx: AppCtx, identityId: string, rawEmail: string | null | undefined): Promise<void> {
  const normalizedEmail = rawEmail ? normalizeEmail(rawEmail) : null;
  if (!normalizedEmail) return;
  const identity = await ctx.prisma.customerIdentity.findUnique({ where: { id: identityId }, select: { normalizedEmail: true } });
  if (identity && !identity.normalizedEmail) {
    await ctx.prisma.customerIdentity.update({ where: { id: identityId }, data: { normalizedEmail } });
  }
}

async function findOrCreateIdentityId(ctx: AppCtx, normalizedPhone: string): Promise<string> {
  const found = await findIdentityId(ctx, normalizedPhone);
  if (found) return found;
  const created = await ctx.prisma.customerIdentity.create({ data: { normalizedPhone } });
  return created.id;
}

/** Read-only lookup (following a merge alias, same as the write path) — for
 *  callers like the customer-dashboard that must never *create* an identity
 *  just by someone entering a phone number that has no orders on file. */
export async function findIdentityId(ctx: AppCtx, normalizedPhone: string): Promise<string | null> {
  const direct = await ctx.prisma.customerIdentity.findUnique({ where: { normalizedPhone }, select: { id: true } });
  if (direct) return direct.id;
  const alias = await ctx.prisma.mergedPhoneAlias.findUnique({ where: { normalizedPhone }, select: { identityId: true } });
  return alias?.identityId ?? null;
}

/** Marks a phone's identity verified — the only path that reaches this
 *  today is the customer-dashboard's own phone-OTP flow (Stage 22). There
 *  is no account/login system yet (Stage 25); this is the sole proof
 *  mechanism until then. Never downgrades: once verified, a later
 *  provisional-looking write for the same phone doesn't undo it. */
export async function verifyCustomerIdentity(ctx: AppCtx, phone: string): Promise<string | null> {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  const identityId = await findOrCreateIdentityId(ctx, normalizedPhone);
  await ctx.prisma.customerIdentity.update({
    where: { id: identityId },
    data: { status: "verified", verifiedAt: new Date() },
  });
  return identityId;
}

/** Identities that plausibly belong to the same real person but haven't
 *  been merged — currently the only signal is two *different* identities
 *  sharing a normalized email. Deliberately surfaced for a human (the
 *  platform owner) to confirm or reject, never acted on automatically. */
export async function findDuplicateCandidates(ctx: AppCtx): Promise<DuplicateCandidateDto[]> {
  const rows = await ctx.prisma.customerIdentity.findMany({
    where: { normalizedEmail: { not: null } },
    include: { customers: { include: { business: { select: { name: true } } } } },
    orderBy: { normalizedEmail: "asc" },
  });
  const byEmail = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.normalizedEmail!;
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key)!.push(row);
  }
  const groups: DuplicateCandidateDto[] = [];
  for (const [normalizedEmail, identities] of byEmail) {
    if (identities.length < 2) continue;
    groups.push({
      normalizedEmail,
      identities: identities.map((i) => ({
        id: i.id,
        normalizedPhone: i.normalizedPhone,
        status: i.status,
        customerCount: i.customers.length,
        businessNames: [...new Set(i.customers.map((c) => c.business.name))],
      })),
    });
  }
  return groups;
}

/** Merges `sourceId` into `targetId` — every Customer row pointed at the
 *  source now points at the target, the source's phone keeps resolving to
 *  the target forever after (via MergedPhoneAlias, not just deleted), trust
 *  already established never downgrades (verified wins over provisional),
 *  and the whole thing is one audited action. 404s (not the entities' real
 *  state) on an unknown id — this route is owner-only, but a not-found is
 *  still cheaper to reason about than leaking which ids exist. */
export async function mergeCustomerIdentities(
  ctx: AppCtx,
  actor: { id: string | null; role: string | null },
  sourceId: string,
  targetId: string,
  reason?: string,
): Promise<void> {
  if (sourceId === targetId) throw httpErrors.createError(400, "Can't merge an identity into itself");
  const [source, target] = await Promise.all([
    ctx.prisma.customerIdentity.findUnique({ where: { id: sourceId } }),
    ctx.prisma.customerIdentity.findUnique({ where: { id: targetId } }),
  ]);
  if (!source || !target) throw httpErrors.createError(404, "Customer identity not found");

  const mergedStatus = source.status === "verified" || target.status === "verified" ? "verified" : target.status;
  const mergedVerifiedAt = target.verifiedAt ?? source.verifiedAt ?? null;
  const mergedEmail = target.normalizedEmail ?? source.normalizedEmail ?? null;

  await ctx.prisma.$transaction([
    ctx.prisma.customer.updateMany({ where: { identityId: sourceId }, data: { identityId: targetId } }),
    // Any earlier merges that pointed AT the source now point at the
    // target instead — a chain of merges must all resolve to one place.
    ctx.prisma.mergedPhoneAlias.updateMany({ where: { identityId: sourceId }, data: { identityId: targetId } }),
    ctx.prisma.mergedPhoneAlias.create({ data: { normalizedPhone: source.normalizedPhone, identityId: targetId } }),
    ctx.prisma.customerIdentity.update({
      where: { id: targetId },
      data: { status: mergedStatus, verifiedAt: mergedVerifiedAt, normalizedEmail: mergedEmail },
    }),
    ctx.prisma.customerIdentity.delete({ where: { id: sourceId } }),
  ]);

  await ctx.audit.record(actor, "customerIdentity.merge", "customerIdentity", targetId, {
    mergedFromId: sourceId,
    mergedFromPhone: source.normalizedPhone,
    intoPhone: target.normalizedPhone,
    reason: reason ?? null,
  });
}

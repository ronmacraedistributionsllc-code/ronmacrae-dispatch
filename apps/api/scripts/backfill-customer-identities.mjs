#!/usr/bin/env node
/**
 * Stage 23 — global customer identity backfill.
 *
 * `Customer.identityId` was added nullable (see schema.prisma) so the
 * schema push itself was purely additive; this script does the actual
 * work: for every existing Customer row across every business, compute its
 * real normalized phone (lib/phone.ts's libphonenumber-based normalizer)
 * and find-or-create the one CustomerIdentity that phone belongs to,
 * linking the row to it. Two different Customer rows (even at different
 * businesses) that normalize to the exact same phone land on the same
 * identity — that's the intended "one global identity" grouping, not a
 * merge (see CustomerIdentity's own doc comment in schema.prisma for why
 * that distinction matters). Every identity created this way starts
 * "provisional" — nothing in historical data proves anyone actually owns
 * these phone numbers; "verified" only ever comes from the customer-
 * dashboard's own phone-OTP flow (Stage 22), going forward.
 *
 * IMPORTANT: `Customer.phone` is stored in an older, non-standard format
 * ("+876XXXXXXX" — not real E.164; Jamaica's actual calling code is
 * "+1876") from modules/auth.ts's own separate, unrelated normalizer (see
 * lib/phone.ts's doc comment for why this script doesn't touch that). The
 * real normalizer can't parse a leading "+876" as-is (no country has that
 * calling code), so this script strips all non-digits before normalizing
 * — exactly the same stripping the real normalizer already does
 * internally for a bare, unprefixed number, just applied explicitly here
 * first since a literal "+" would otherwise be taken as a real E.164
 * prefix and misread.
 *
 * Safety: dry-run by default (prints a summary, changes nothing, exits 0).
 * Pass --yes to actually execute. One transaction.
 *
 * Usage (from apps/api, with DATABASE_URL pointing at the dev.db to fix):
 *   node scripts/backfill-customer-identities.mjs          # dry run
 *   node scripts/backfill-customer-identities.mjs --yes    # actually backfill
 */
import { PrismaClient } from "@prisma/client";
import { parsePhoneNumberFromString } from "libphonenumber-js";

const yes = process.argv.slice(2).includes("--yes");
const prisma = new PrismaClient();

function normalizePhone(raw) {
  const digits = raw.replace(/\D+/g, "");
  const parsed = parsePhoneNumberFromString(digits, "JM");
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

async function main() {
  const customers = await prisma.customer.findMany({
    where: { identityId: null },
    select: { id: true, phone: true, email: true },
  });
  if (customers.length === 0) {
    console.log("[backfill-customer-identities] nothing to do — every Customer row already has an identity.");
    return;
  }

  const byPhone = new Map(); // normalizedPhone -> { customerIds: string[], email: string|null }
  let unparseable = 0;
  for (const c of customers) {
    const phone = normalizePhone(c.phone);
    if (!phone) {
      unparseable += 1;
      continue;
    }
    const entry = byPhone.get(phone) ?? { customerIds: [], email: null };
    entry.customerIds.push(c.id);
    if (!entry.email && c.email) entry.email = c.email.trim().toLowerCase();
    byPhone.set(phone, entry);
  }

  console.log(
    `[backfill-customer-identities] ${customers.length} Customer row(s) without an identity; ` +
      `${byPhone.size} distinct identity/identities to create/reuse, covering ${customers.length - unparseable} row(s); ` +
      `${unparseable} row(s) left unlinked (phone doesn't normalize — same honest "no match" behavior the live system uses).`,
  );

  if (!yes) {
    console.log("[backfill-customer-identities] dry run only — pass --yes to apply.");
    return;
  }

  let created = 0;
  let reused = 0;
  for (const [normalizedPhone, entry] of byPhone) {
    await prisma.$transaction(async (tx) => {
      let identity = await tx.customerIdentity.findUnique({ where: { normalizedPhone } });
      if (identity) {
        reused += 1;
        if (entry.email && !identity.normalizedEmail) {
          await tx.customerIdentity.update({ where: { id: identity.id }, data: { normalizedEmail: entry.email } });
        }
      } else {
        identity = await tx.customerIdentity.create({ data: { normalizedPhone, normalizedEmail: entry.email } });
        created += 1;
      }
      await tx.customer.updateMany({ where: { id: { in: entry.customerIds } }, data: { identityId: identity.id } });
    });
  }
  console.log(`[backfill-customer-identities] done — ${created} identity/identities created, ${reused} reused, ${unparseable} row(s) left unlinked.`);
}

main()
  .catch((err) => {
    console.error("[backfill-customer-identities] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

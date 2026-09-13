# Phase 3 — Courier Branding & Access Checkpoint

**Status: IN PROGRESS.** This supersedes `PHASE1_JOBS_CHECKPOINT.md` and
`PHASE2_JOBS_SCREEN_CHECKPOINT.md` for `/continue-build` purposes — those
describe the project in its earliest state (a single-business jobs board,
27 tests total) and are badly out of date. The app today is a multi-tenant
platform: multiple merchants, logistics/fleet companies, riders, a
Platform Admin console, COD reconciliation, reports, and non-job-scoped
messaging, built across 39 stages since Phase 2. **Do not trust Phase 1/2
for current scope or file layout.**

The deeper, narrative record of every stage is `WORK_IN_PROGRESS.md`
(chronological) and `HANDOFF.md` (a point-in-time recovery snapshot,
tag `pre-courier-branding-handoff`) at the repo root — read those only if
this file doesn't answer what you need; do not re-read the whole repo.

## Scope (this phase)

Five tasks, requested together, of which one is done:

- **A — Courier verification email (DONE, this checkpoint).** Fixed a
  silent-failure bug; production delivery is still unconfirmed (no real
  inbox/Resend/Render dashboard access from the session that fixed this).
- **B — Rename "Rider" to "Courier" in all user-facing text** (not
  implemented). Must NOT rename internal identifiers (`Rider` model,
  `RiderDto`, `/api/bearer/*`, `role: "rider"`) — text only.
- **C — Shared signup gains a "Merchant Business" option**, with a real
  pending-application → admin approval → owner-portal flow (not
  implemented).
- **D — Courier business-access scoping**: a courier must see only
  orders/customers/messages/cash/tracking/routes for merchants/logistics
  companies they're actively attached to, enforced at UI *and* API,
  including manual URL/API attempts (not implemented — needs investigation
  of how much multi-tenant isolation already exists at the *merchant*
  level vs. just the *business* level before writing code).
- **E — Theme switcher**: 4 new premium themes (Ronmacrae Blue, Midnight
  Gold, Clean Light, Night Courier) toggleable from the bottom of the
  signed-in sidebar/settings, persisted per user, default theme unchanged
  (not implemented).

## Fixes applied (Task A, concrete)

1. `apps/api/src/modules/customer-account.ts` — `sendEmailCode()`
   discarded the return value of `EmailProvider.send()`
   (`packages/notifications/src/email.ts`), whose failure paths all
   return `{status:"failed", error}` rather than throwing. A real send
   failure therefore produced no error, no log, and a false success. Now
   checks the result, deletes the never-delivered code row (so an
   immediate retry isn't blocked by the unrelated cooldown), logs the
   provider's own error via `ctx.log` (never the code), and throws a 502.
2. `apps/api/src/modules/riders.ts` — `RidersService.selfSignup()`'s
   "existing rider" branch (hit when someone resubmits the same phone
   after a failed first attempt) now resends a code if the account's
   email is still unverified, instead of silently succeeding with
   nothing sent.
3. `apps/web/src/pages/join-rider.tsx` — a 502 on submit now moves the
   applicant to the verify step with an honest message and a resend
   button, instead of a form that looks like it did nothing.

## Commands run and results

| Command (working dir: repo root unless noted) | Result |
| --- | --- |
| `npm run typecheck --workspace apps/api --workspace apps/web` | 0 errors |
| `DEV_DB=1 npx vitest run` (`apps/api`) | **276/276 pass**, 39 files |
| `npm run build --workspace apps/api --workspace apps/web` | success |
| `rm -f apps/api/data/e2e-test.db && cd e2e && npx playwright test --workers=1` | **34/35 pass** — 1 known pre-existing failure, see below |

The one e2e failure, `specs/booking.spec.ts` (address-autocomplete
timeout on the offline geocoding fallback), is confirmed pre-existing and
unrelated — do not spend time on it as part of this phase's tasks.
**Always run e2e with `--workers=1`** — the default parallel-worker mode
produces spurious extra failures from shared dev-server/db/realtime-hub
contention, not real regressions.

## Out of scope / notes

- Task A's production-email diagnosis is NOT complete — no real inbox,
  Resend dashboard, or Render dashboard was reachable this session. The
  next session with that access must confirm a real send before telling
  anyone this is fixed.
- Two other production items flagged in `HANDOFF.md` remain unconfirmed:
  whether the Render Postgres plan is still on a free/time-limited tier,
  and whether `grant-platform-owner` was ever run for the real admin.
- This repo uses `prisma db push` (no `prisma/migrations` directory) —
  never run it with `--accept-data-loss` against the production
  `DATABASE_URL`.
- Tasks B–E are each roughly the size of one full prior stage (see
  `WORK_IN_PROGRESS.md`'s Stage 33/36/37 for comparable scope) — treat
  each as its own `/continue-build` run with its own checkpoint update,
  not one combined patch.

## Re-verify

```bash
npm run typecheck --workspace apps/api --workspace apps/web
DEV_DB=1 npx vitest run --root apps/api
npm run build --workspace apps/api --workspace apps/web
rm -f apps/api/data/e2e-test.db && cd e2e && npx playwright test --workers=1
```

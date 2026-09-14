# Phase 3 — Courier Branding & Access Checkpoint

**Status: IN PROGRESS (A and B done; C and E partial; D not started).**
This corrects Luna's own self-report in this file as of commit `11eb040`,
which read "Tasks A and B complete" — her actual commits also built real
parts of C and E, and none of D. Both directions matter: don't undercount
what shipped, and don't assume anything is done that isn't. This file
supersedes `PHASE1_JOBS_CHECKPOINT.md` and `PHASE2_JOBS_SCREEN_CHECKPOINT.md`
for `/continue-build` purposes (both describe the project's earliest,
single-business state and are badly out of date — do not trust them for
current scope or file layout).

The deeper, narrative record is `WORK_IN_PROGRESS.md` (chronological) and
`HANDOFF.md` (a point-in-time recovery snapshot, tag
`pre-courier-branding-handoff`) at the repo root — read those only if this
file doesn't answer what you need; do not re-read the whole repo.

## Scope (this phase) — honest status per task

- **A — Courier verification email: DONE.** Fixed a silent-failure bug
  (`sendEmailCode()` now checks the provider's send result and reports a
  real error instead of a false success — see `WORK_IN_PROGRESS.md`'s
  Stage A). Luna's `62e632c` added a complementary boot-time check
  (`EMAIL_PROVIDER=resend` without `RESEND_API_KEY`/`EMAIL_FROM` now fails
  fast at startup) and exposed the active provider on `/api/health`.
  **Production delivery is still unconfirmed** — no real inbox, Resend
  dashboard, or Render dashboard has been reachable from any session so
  far. Do not tell anyone this is fixed until a real send is confirmed.
- **B — Rename "Rider" to "Courier" (user-facing text): DONE.** Verified:
  typecheck, the full test suite, and a full e2e run (see below) all pass
  with the renamed labels, including `e2e/specs/booking.spec.ts`'s
  "Local delivery (our couriers)" option text. Internal identifiers
  (`Rider` model, `RiderDto`, `/api/bearer/*`, `role: "rider"`) are
  unchanged, as required.
- **C — Shared signup with a Merchant Business option: PARTIAL.**
  Built: `/join/merchant` (a real signup form: owner name, business name,
  email, phone, pickup address, password), linked from the shared
  `/login` page alongside "Sign up as courier" and "Sign up as customer".
  Creates the merchant as `active: false` (pending) on the existing
  shared `User`/`MerchantStaff` account system — no duplicate account or
  login system. Email-verifies via the same `sendEmailCode()` Task A
  fixed. A business admin (or platform owner) approves by toggling
  `active: true` — the same mechanism Platform Admin already used to
  disable/reactivate a merchant (Stage 34), now doing double duty as
  "approve a new application." Integration-tested in
  `merchant-portal.test.ts` (signup → verify → login-blocked-while-
  pending → approve → login-succeeds).
  **Real gaps, not yet done:**
  - No distinct "rejected" state — reject and disable both set the same
    `active: false`, so Platform Admin can't currently tell a brand-new
    pending application apart from a merchant it disabled last year, and
    there's no rejection reason field.
  - No self-signup option for a **Bearer/Logistics Company** — the login
    page offers Customer/Courier/Merchant only, not the fourth type the
    spec asked for. Logistics companies are still admin-created only
    (Stage 36's existing flow).
  - No notification to Platform Admin when a new application arrives
    (unlike the existing dispatch/merchant order-notification emails).
  - The only test coverage is a `vitest` API integration test, not a
    real end-to-end browser test — and it doesn't cover an explicit
    rejection path, since there isn't one to test.
- **D — Courier business-access scoping: NOT STARTED.** A `MerchantRider`
  model now exists (Luna's `e141741`) as a many-to-many roster — but it
  is **only enforced on the merchant side** (a merchant can manage/assign
  couriers on its own roster and can't touch another merchant's roster or
  order — verified, see `merchant-portal.test.ts`'s "cannot assign a
  courier outside its roster" case). **Nothing restricts what a courier
  sees.** `grep -rn "MerchantRider" apps/api/src/modules/` outside
  `merchant-portal.ts`/`platform-admin.ts` returns nothing — the
  courier's own job list, orders, customers, messages, cash, tracking,
  and routes are filtered exactly as before this phase (by
  `RiderMembership`/business, not by merchant attachment). This is the
  spec's explicit security requirement ("prevent cross-merchant access at
  both UI and API level, including manual URL/API attempts") and it has
  not been built. Treat this as the next task, not a follow-up detail.
- **E — Theme switcher: PARTIAL.** Built: a `jamaica` theme (black/green/
  gold), CSS variables so every theme (including the existing default) is
  actually readable everywhere, and a compact selector on the login page
  and the staff sidebar footer (full switcher lives in Settings). Default
  theme is unchanged, as required.
  **Real gaps, not yet done:** the four specifically-named themes
  (Ronmacrae Blue, Midnight Gold, Clean Light, Night Courier) were not
  built — `jamaica` is a different theme, not a stand-in for one of the
  four. No preview/selection screen or screenshots were produced for
  choosing a future default.

## Fixes applied (Task A, concrete — carried over from the prior checkpoint)

1. `apps/api/src/modules/customer-account.ts` — `sendEmailCode()` now
   checks the email provider's send result, deletes the never-delivered
   code row on failure (so an immediate retry isn't blocked by the
   unrelated cooldown), logs the provider's own error via `ctx.log`
   (never the code), and throws a 502 instead of silently succeeding.
2. `apps/api/src/modules/riders.ts` — `selfSignup()`'s "existing rider"
   branch now resends a code when the account's email is still
   unverified, instead of silently succeeding with nothing sent again.
3. `apps/web/src/pages/join-rider.tsx` — a 502 on submit moves the
   applicant to the verify step with an honest message and a resend
   button.
4. (Luna, `62e632c`) `apps/api/src/config.ts`/`server.ts` — boot-time
   validation that `EMAIL_PROVIDER=resend` has real credentials, and the
   active provider name surfaced on `/api/health`.

## Commands run and results — independently re-verified, not just Luna's own report

| Command (working dir: repo root unless noted) | Result |
| --- | --- |
| `npm run typecheck --workspace apps/api --workspace apps/web` | 0 errors |
| `DEV_DB=1 npx vitest run --root apps/api` | **287/287 pass**, 39 files (Luna's own last run in this file previously reported 270/276 with "6 unrelated 5-second timeouts" — re-run independently here came back fully clean; treat that as transient resource contention, not a real gap, but re-verify if it recurs) |
| `npm run test:unit --workspace apps/web` | **10/10 pass**, 3 files |
| `npm run test:unit --workspace packages/contracts` | **8/8 pass** |
| `npm run test:unit --workspace packages/notifications` | **6/6 pass** |
| `npm run build --workspace apps/api --workspace apps/web` | success |
| `rm -f apps/api/data/e2e-test.db && cd e2e && npx playwright test --workers=1` | **35/35 pass** — see below, this includes a genuine fix to the long-standing `booking.spec.ts` flake |
| `DEV_DB=1 node apps/api/scripts/prepare-db.mjs` | schema valid, pushes cleanly to sqlite; the `Rating`/`MerchantRider` schema changes are purely additive (new enum value, new nullable columns, new model, new indexes) — safe for `prisma db push` against production Postgres with no data-loss warning |

**The previously "pre-existing, unrelated" `booking.spec.ts` failure is
now genuinely fixed**, not just newly passing by chance: Luna's `62e632c`
diagnosed the real cause (the offline geocoder legitimately returns no
suggestion sometimes, and the app's own UI already supports confirming a
manual pin in that case — the test just never handled that branch) and
updated the test to follow the same fallback path a real user would.
Every stage in this project's history before this one had this failure
and dismissed it as environmental; it wasn't only that.

**Always run e2e with `--workers=1`** — the default parallel-worker mode
has repeatedly produced spurious extra failures from shared dev-server/
db/realtime-hub contention this session, not real regressions.

## Out of scope / notes

- Task A's production-email diagnosis is still NOT complete — no real
  inbox, Resend dashboard, or Render dashboard reachable from any session
  so far.
- Two other production items flagged in `HANDOFF.md` remain unconfirmed:
  whether the Render Postgres plan is still on a free/time-limited tier,
  and whether `grant-platform-owner` was ever run for the real admin.
- This repo uses `prisma db push` (no `prisma/migrations` directory) —
  never run it with `--accept-data-loss` against the production
  `DATABASE_URL`.
- The `331ce11` commit ("checkpoint: preserve in-progress changes before
  Phase 1 audit") touched a very wide set of files in one commit — it
  passed every check re-run above, but its own message suggests it was a
  "save everything" commit rather than one scoped change. Worth knowing
  if something unexpected turns up later that doesn't map to A/B/C/D/E.

## Re-verify

```bash
npm run typecheck --workspace apps/api --workspace apps/web
DEV_DB=1 npx vitest run --root apps/api
npm run test:unit --workspace apps/web
npm run test:unit --workspace packages/contracts
npm run test:unit --workspace packages/notifications
npm run build --workspace apps/api --workspace apps/web
rm -f apps/api/data/e2e-test.db && cd e2e && npx playwright test --workers=1
```

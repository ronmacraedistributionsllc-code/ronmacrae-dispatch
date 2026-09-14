# Phase 3 — Courier Branding & Access Checkpoint

**Status: IN PROGRESS (A, B, D done; C and E partial).**
This file supersedes `PHASE1_JOBS_CHECKPOINT.md` and
`PHASE2_JOBS_SCREEN_CHECKPOINT.md` for `/continue-build` purposes (both
describe the project's earliest, single-business state and are badly out
of date — do not trust them for current scope or file layout).

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
- **D — Courier business-access scoping: DONE.** Investigated first
  (per this repo's own standing rule): a courier's job list/detail/
  transition routes (`/api/bearer/jobs*`) were already correctly scoped
  by `riderId` — the real, confirmed gap was on the *merchant* side, not
  the courier's own job visibility. Fixed:
  - `GET /api/merchant-portal/riders/search` and `POST
    /api/merchant-portal/riders` (Luna's roster feature) previously
    searched/attached **any rider on the entire platform**, with no
    business scoping at all — any merchant could discover and attach a
    courier it has no relationship with. Now scoped to couriers who are
    active `RiderMembership` members of the merchant's own business
    (same "the vouching party is itself already vetted" pattern used
    everywhere else in this app) — 404, not 403, for an out-of-business
    rider, so a merchant never learns whether a given phone/email/id
    belongs to a real rider outside its own business.
  - New `GET /api/bearer/me` (a pre-existing but never-implemented route
    constant) — the spec's explicit "show the courier their active
    business memberships clearly": every active `RiderMembership`
    business, every active `MerchantRider` roster attachment, and the
    separate Platform-Admin-controlled offer-eligibility attachment
    (`Rider.attachment`) — all from the courier's own token, never a
    client-supplied id. Surfaced in `rider-dashboard.tsx` as a
    collapsed "My businesses" section.
  - Added explicit tests proving cross-courier job access is refused via
    direct API calls (accept/transition/stage on another courier's job —
    "manual URL/API attempts" per the spec), that a courier's own job
    list never includes another courier's job, and that `/api/bearer/me`
    never leaks a pending/removed/other-business relationship.
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

## Fixes applied (Task D, concrete)

1. `apps/api/src/modules/merchant-portal.ts` — `GET
   /api/merchant-portal/riders/search` and `POST
   /api/merchant-portal/riders` now require the target rider to have an
   active `RiderMembership` at the merchant's own `businessId` (a plain
   `findMany`/`findUnique` filter, no schema change) — closing a
   platform-wide rider-discovery/attachment gap.
2. `apps/api/src/modules/bearer.ts` — new `GET /api/bearer/me`
   (`BearerMeDto` in `packages/contracts/src/types.ts`): the courier's own
   `RiderDto`, active business memberships, active merchant roster
   attachments, and Platform-Admin attachment, all token-derived.
3. `apps/web/src/pages/rider-dashboard.tsx` — a collapsed "My businesses"
   section using the new endpoint.
4. `apps/api/test/bearer-me.test.ts` (new) + `merchant-portal.test.ts`
   (extended) — 6 new tests: `/api/bearer/me`'s isolation (own data only,
   no pending/removed/other-business leakage), rider-only access, direct
   cross-courier job-access attempts refused (accept/transition/stage),
   job-list isolation, and the merchant search/add business-scoping fix
   (including a positive case proving it's a real scoping rule, not a
   broken lookup).

## Commands run and results — independently re-verified, not just Luna's own report

| Command (working dir: repo root unless noted) | Result |
| --- | --- |
| `npm run typecheck --workspace apps/api --workspace apps/web` | 0 errors |
| `DEV_DB=1 npx vitest run --root apps/api` | **293/293 pass**, 40 files (up from 287/39 — 6 net new for Task D) |
| `npm run test:unit --workspace apps/web` | **10/10 pass**, 3 files |
| `npm run test:unit --workspace packages/contracts` | **8/8 pass** |
| `npm run test:unit --workspace packages/notifications` | **6/6 pass** |
| `npm run build --workspace apps/api --workspace apps/web` | success |
| `rm -f apps/api/data/e2e-test.db && cd e2e && npx playwright test --workers=1` | **35/35 pass** — see below, this includes a genuine fix to the long-standing `booking.spec.ts` flake |
| `DEV_DB=1 node apps/api/scripts/prepare-db.mjs` | schema valid, pushes cleanly to sqlite; the `Rating`/`MerchantRider` schema changes (Luna) are purely additive (new enum value, new nullable columns, new model, new indexes) — safe for `prisma db push` against production Postgres with no data-loss warning. Task D added no schema change. |

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
- Task D's design decision: a merchant attaching a courier who is already
  an active member of its own business counts as the spec's "authorized
  business assignment" (no separate Platform Admin approval step added
  for that specific case) — matches how staff-created rider/merchant
  relationships already work elsewhere in this app (the creator's own
  vetted status is the vouching). Platform Admin's separate,
  single-merchant `Rider.attachment` mechanism (Stage 36, drives offer
  eligibility) is untouched and deliberately NOT reconciled with the
  newer many-to-many `MerchantRider` roster — a freelance rider added to
  a merchant's roster still gets broadcast offers from every merchant
  (unrestricted), since roster membership and offer eligibility are
  different concerns in this app. If that turns out to be wrong, it's a
  business-rule change to `offers.ts`'s `eligibleRiders()`, not an
  access-control bug.

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

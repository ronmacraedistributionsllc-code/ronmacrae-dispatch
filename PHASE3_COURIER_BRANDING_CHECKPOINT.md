# Phase 3 — Courier Branding & Access Checkpoint

**Status: A, B, C, D, E all done.**
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
- **C — Shared signup with a Merchant Business option: DONE.** Extended
  in this pass to close all four gaps this checkpoint previously flagged:
  - **Distinct rejected state.** `Merchant`/`LogisticsCompany` both got a
    new `applicationStatus` (`pending`/`approved`/`rejected`) plus
    `rejectionReason`/`reviewedAt`/`reviewedById`, separate from `active`
    — defaulted to `approved` so every existing record and every
    staff-created one (never a self-signup) needs no backfill and no
    review step. New owner-only `POST /api/platform/merchants/:id/review`
    and the logistics-company equivalent take `{decision:
    "approve"|"reject", reason?}` (reason required to reject); the plain
    active-toggle `PATCH` routes now refuse a still-`pending` record
    (400, "approve or reject it first") so an owner can't silently
    activate an application without ever deciding it — though a
    *business admin* activating one through the existing staff-level
    `PATCH /api/merchants/:id` (their own pre-existing approval path,
    Stage checkpoint's earlier note) still can, and that route now syncs
    `applicationStatus` to `approved` itself so Platform Admin's console
    badge never gets stuck showing "Pending review" for a merchant
    that's actually active.
  - **Bearer/Logistics Company self-signup.** New `/join/logistics` page
    and `POST /api/logistics-signup` (+`/verify`, `/resend`) — an exact
    mirror of merchant-signup's shape and flow (shared `User`/
    `LogisticsCompanyStaff` account, pending until reviewed, same
    email-verification gate). The shared `/login` page now lists all
    four account types the spec named.
  - **Platform Admin notification.** New `platform-notify.ts` — same
    "never blocks the caller, best-effort, audited" contract as
    `dispatch-notify.ts`/`merchant-notify.ts`: emails every active
    `platformRole: "owner"` account with an address set, fired
    fire-and-forget right after a merchant/logistics-company signup
    succeeds. A fresh install with no owner account yet is a silent
    no-op, not an error.
  - **Real end-to-end browser coverage.** New
    `e2e/specs/business-signup.spec.ts` drives the actual UI — the
    shared login page's four signup links, a full merchant lifecycle
    (pending → Platform Admin approves → the applicant logs in through
    the *same shared login page*, in a separate browser context → owner
    disables it → that login is refused again), and a logistics-company
    rejection (with the reason staying visible in the console). The
    verification-code step itself is still never driven through the
    browser — same rationale as `my-packages.spec.ts`: the code is
    genuinely never exposed to any browser/API surface, so applications
    are created via a direct API call instead, and review deliberately
    doesn't require the email to be verified first.
  - **New seeded account**: `owner@ronmacrae.example` / `owner1234` — a
    dedicated platform-owner login for Platform Admin, with deliberately
    **no** business `StaffMembership`. Previously nothing seeded
    `platformRole: "owner"` at all, so Platform Admin had zero e2e
    coverage and a fresh clone couldn't reach that console without
    manually running `grant-platform-owner.ts`. Kept strictly separate
    from the `admin@ronmacrae.example` business account on purpose — see
    the comment on `seedPlatformOwner()` in `seed.ts` for why a *shared*
    account is the trap, not a shortcut (this is the same confusion
    documented under Task E below, now prevented at the source).
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
- **E — Theme switcher: DONE.** Correction to this checkpoint's own prior
  entry: on closer reading of Luna's actual CSS diff (not just her commit
  message), 3 of the 4 specifically-named themes — Midnight Gold, Clean
  Light, Night Courier — were already real, well-built CSS token blocks;
  only "Ronmacrae Blue" was genuinely missing. Built in this pass:
  - `apps/web/src/styles.css` — `Ronmacrae Blue` theme (deep navy /
    electric blue / white), same `:root[data-theme="..."]` token pattern
    as the other five. `--theme-accent` deliberately kept light
    (`#5aa9ff`, not a darker mid-blue) — `.btn-accent` always renders
    `--theme-brand-dark` (near-black) text on top of `--theme-accent`,
    and every other theme's accent is light gold/amber for exactly this
    contrast reason.
  - Per-user **server-side** persistence (the spec's "persist per user"
    — Luna's version was localStorage-only, per-browser not per-account):
    `User.theme` column, `PUT /api/auth/theme` (any signed-in staff or
    rider, their own token only), `theme` on `UserDto`, applied once on
    session load in `lib/auth.tsx`'s `loadMe()` so a saved preference
    follows the person to a new device — overriding, not merged with,
    that device's own localStorage.
  - `apps/web/src/pages/theme-preview.tsx` (new) — the spec's "visual
    preview/selection screen": all 6 themes (5 + `jamaica`) as cards with
    a live mock dispatch-UI preview, swatches, description, an "Active"
    badge, and a real "Use this theme" button (applies immediately and
    persists). Linked from both the sidebar's compact selector ("Preview
    all") and Settings.
  - Verified live in a real browser against real data (72 seeded jobs):
    logged in as a genuine business-scoped dispatcher (not the
    platform-owner demo account — see note below), applied all 4
    newly-relevant themes to the Jobs screen and the dashboard, confirmed
    legible contrast and no unstyled/leftover-dark-mode elements in any
    of them, and confirmed the `PUT /api/auth/theme` round-trip actually
    persists (a fresh `/api/auth/refresh` reflects the saved value).
  Default theme is unchanged, as required.
  **While testing this, found and fixed one real, pre-existing, unrelated
  bug** (not a Task E regression — predates this stage): `login.tsx`
  rendered a static "Redirecting…" string for an already-authenticated
  visit to `/login` but never actually called `navigate()` — a stale tab,
  bookmark, or back-button nav back to `/login` left a signed-in user
  permanently stuck on that screen with no way forward. Fixed with
  `<Navigate to="/" replace />`, the same idiom `Protected` already uses
  for the opposite case. New e2e coverage:
  `e2e/specs/smoke.spec.ts`'s "an already-authenticated visit to /login
  redirects straight into the dashboard".
  **Also found, NOT a bug, a local-session-only trap worth recording:**
  the seeded `admin@ronmacrae.example` account had `platformRole: "owner"`
  granted against the local dev DB earlier in this same working session
  (via `apps/api/src/grant-platform-owner.ts`, while testing Task C's
  merchant-approval flow). `resolveStaffContext()`
  (`apps/api/src/modules/auth.ts`) deliberately returns `businessId: null`
  for ANY platform-owner session, regardless of that same user's real
  business `StaffMembership` rows — by design (see the comment in
  `apps/api/src/modules/guards.ts`'s `makeRequireStaff`), so that account
  correctly 403s on every business-scoped route (`/api/jobs` included)
  until it switches back to a plain business-staff context. This produced
  a confusing "Jobs screen stuck loading, 403 Forbidden" symptom during
  manual testing that had nothing to do with Task D or E's code — it
  reproduces on a completely unmodified checkout too, given the same
  local `grant-platform-owner` action. Not fixed (working as designed);
  recorded here so a future session doesn't re-diagnose it from scratch.
  `HANDOFF.md`'s open question "whether `grant-platform-owner` was ever
  run for the real admin" is the same concern — worth explicitly
  confirming it was NOT run against the production database.

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

## Fixes applied (Task C, concrete)

1. `apps/api/prisma/schema.prisma` — new `ApplicationStatus` enum
   (`pending`/`approved`/`rejected`); `Merchant`/`LogisticsCompany` both
   get `applicationStatus` (default `approved`), `rejectionReason`,
   `reviewedAt`, `reviewedById` (+ `User` reverse relations). Additive
   only — safe `prisma db push` against production Postgres.
2. `apps/api/src/modules/platform-notify.ts` (new) —
   `notifyOwnersOfApplication()`.
3. `apps/api/src/modules/merchants.ts` — signup sets
   `applicationStatus: "pending"` and fires the notify (fire-and-forget);
   the staff `PATCH /api/merchants/:id` route syncs `applicationStatus`
   to `approved` when it activates a still-pending one.
4. `apps/api/src/modules/logistics-companies.ts` — new
   `POST /api/logistics-signup` (+`/verify`, `/resend`), mirroring
   merchants.ts's signup exactly; its own staff `PATCH` route gets the
   same implicit-approval sync as merchants.ts.
5. `apps/api/src/modules/platform-admin.ts` — new
   `POST /api/platform/merchants/:id/review` and the logistics-company
   equivalent (`{decision: "approve"|"reject", reason?}`, reason
   required to reject, 409 if already reviewed); both list routes now
   return `applicationStatus`/`rejectionReason`/`reviewedAt`/
   `reviewedByName`; both plain active-toggle `PATCH` routes now refuse
   a still-`pending` record (400).
6. `apps/api/src/modules/auth.ts` — the two new public signup routes
   added to the global auth allowlist.
7. `apps/api/src/seed.ts` — new `seedPlatformOwner()`, seeds
   `owner@ronmacrae.example` / `owner1234` with no business
   `StaffMembership` (see its own doc comment for why that separation
   matters).
8. `packages/contracts/src/routes.ts` — `logisticsSignup` block,
   `platform.reviewMerchant`/`reviewLogisticsCompany`.
9. `apps/web/src/pages/join-logistics.tsx` (new) — mirrors
   `join-merchant.tsx`. `apps/web/src/pages/login.tsx` — the fourth
   signup link. `apps/web/src/app.tsx` — the `/join/logistics` route.
10. `apps/web/src/pages/platform-admin.tsx` — new shared `ApplicationRow`/
    `ApplicationBadge` components; `MerchantsTab`/`LogisticsTab` show a
    "Pending review" badge with Approve/Reject controls (reject opens an
    inline reason field) for a pending application, and the existing
    StatusPill + Disable/Reactivate for an already-reviewed one; a
    rejected row shows its reason and who reviewed it.
11. `apps/api/test/logistics-signup.test.ts` (new, 4 tests),
    `apps/api/test/merchant-portal.test.ts` (+2 tests: rejection with
    reason, disabled-access-after-approval — both previously-flagged
    gaps), `e2e/specs/business-signup.spec.ts` (new, 3 tests, real
    browser coverage — previously none existed for this flow or for
    Platform Admin at all).

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

## Fixes applied (Task E, concrete)

1. `apps/api/prisma/schema.prisma` — `User.theme String?` (nullable,
   additive — safe `prisma db push` against production Postgres).
2. `apps/api/src/modules/auth.ts` — `toUserDto()` includes `theme`; new
   `PUT /api/auth/theme` (`ctx.requireAuth`, any signed-in staff/rider,
   own token only, `{ theme: string | null }`, max 60 chars, free text so
   an older/newer client or a removed theme id simply falls back).
3. `packages/contracts/src/types.ts` / `routes.ts` — `UserDto.theme`,
   `API.auth.theme`.
4. `apps/web/src/styles.css` — `Ronmacrae Blue` theme block.
5. `apps/web/src/lib/theme.tsx` — `THEMES` now lists 6 entries;
   `chooseTheme()` (local apply + fire-and-forget `PUT` persist, used by
   every picker) added alongside the existing local-only `setTheme()`;
   new `applyRemoteTheme()` called once from `loadMe()` on session
   restore so a saved server preference follows the person to a new
   device.
6. `apps/web/src/lib/theme-palettes.ts` (new) — a hand-duplicated mirror
   of `styles.css`'s token values (not read live — the app's
   `:root[data-theme=...]` architecture only supports one active theme
   for the whole document, so the preview page's side-by-side cards use
   inline styles instead of live CSS-variable scoping) for
   `theme-preview.tsx`'s mock previews.
7. `apps/web/src/pages/theme-preview.tsx` (new), routed at
   `/theme-preview`, linked from the sidebar and Settings.
8. `apps/web/src/lib/auth.tsx` — `loadMe()` calls `applyRemoteTheme`.
9. `apps/web/src/pages/login.tsx` — the "Redirecting…" fix described
   above.
10. `apps/api/test/auth-theme.test.ts` (new, 3 tests),
    `apps/web/src/lib/theme.test.tsx` (extended, +6 tests; also fixed a
    pre-existing test-isolation bug — a `describe` block's own
    `beforeEach` localStorage reset wasn't shared with sibling blocks,
    hoisted to file level), `e2e/specs/smoke.spec.ts` (+1 test, the
    login-redirect fix).

## Commands run and results — independently re-verified, not just Luna's own report

| Command (working dir: repo root unless noted) | Result |
| --- | --- |
| `npm run typecheck --workspace apps/api --workspace apps/web` | 0 errors |
| `DEV_DB=1 npx vitest run --root apps/api` | **302/302 pass**, 42 files (up from 296/41 — `logistics-signup.test.ts` new (4), `merchant-portal.test.ts` +2, Task C) |
| `npm run test:unit --workspace apps/web` | **15/15 pass**, 3 files |
| `npm run test:unit --workspace packages/contracts` | **8/8 pass** |
| `npm run test:unit --workspace packages/notifications` | **6/6 pass** |
| `npm run build --workspace apps/api --workspace apps/web` | success |
| `rm -f apps/api/data/e2e-test.db && npx playwright test --config=e2e/playwright.config.ts --workers=1` | **39/39 pass** — up from 36, `business-signup.spec.ts` new (3 tests, Task C) |
| `DEV_DB=1 node apps/api/scripts/prepare-db.mjs` | schema valid, pushes cleanly to sqlite; Task C's schema changes (new `ApplicationStatus` enum, new nullable columns + a default on `Merchant`/`LogisticsCompany`) are purely additive — safe for `prisma db push` against production Postgres with no data-loss warning. |

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
- Task C's new seeded `owner@ronmacrae.example` / `owner1234` only
  exists because `seed.ts` was run — it is **not** created by
  `bootstrap-prod.ts` and will not appear on the live Render deployment
  automatically. The production account owner still needs
  `grant-platform-owner.ts` (`GRANT_OWNER_EMAIL=<their email>`) run
  against production once, same as before this stage — this is a new
  convenience for local dev/e2e only, not a change to how production
  gets its first platform owner.

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

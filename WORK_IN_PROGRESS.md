# Work in progress — offers/GPS/alerts handoff (resumed by Claude Code, 2026-09-10)

Read this first if you're resuming after a cutoff. It tracks exactly what's done vs.
not, across the six stages requested. Long-form verification detail for completed
work lives in `PHASE1_JOBS_CHECKPOINT.md`; this file is the short "where are we"
status plus the concrete next action.

## Recovery context

- Took over from an interrupted OpenCode session. The repo had **no git history**
  (`.git` didn't exist) when this session started.
- A git baseline commit now exists: `Recovery baseline: source snapshot after
  interrupted OpenCode session`. `.env` and all `*.db`/`*.db.bak*` files are
  gitignored and were never staged.
- `apps/api/data/dev.db.bak-offers` (434,176 bytes, made 2026-09-10 08:50, before the
  `JobOffer` table push) is still present and untouched — that's the pre-existing DB
  backup from the OpenCode session, kept as a rollback point for the schema change.
  `apps/api/data/dev.db` itself is also untouched by this session's work (integration
  tests run against a disposable `apps/api/data/test-*.db`, deleted after each run).
- The OpenCode handoff summary claimed `assign.ts` "reportedly" had a race-safe
  change and `offers.ts` "still needs acceptance/rebroadcast changes" — **verified
  against actual code, not assumed**: `assign.ts` already withdrew open offers
  atomically, and `offers.ts`'s accept route was already an atomic conditional claim.
  The one real gap found by inspection: `rebroadcast` didn't re-check rider capacity
  the way `broadcast` did (fixed in Stage 1 below).

## Stage status

| # | Stage | Status |
| - | ----- | ------ |
| 1 | Atomic offer acceptance/assignment, eligibility, expiration, withdrawal, closing competing offers | **DONE** — see below |
| 2 | Concurrency + authorization tests | **DONE** — `apps/api/test/offers.test.ts`, 8/8 passing |
| 3 | Dispatcher broadcast/assign UI + rider Accept/Decline cards | **NOT STARTED** |
| 4 | Live in-app alerts + opt-in browser push | **NOT STARTED** |
| 5 | Foreground GPS, dispatcher maps, secure customer tracking | **NOT STARTED** |
| 6 | Full workflow tests, typecheck, build, preview instructions | **PARTIAL** — backend gates green (see below); full workflow (stages 3-5) untested because unbuilt |

## Stage 1 — done (this session)

- `apps/api/src/modules/offers.ts`: extracted a shared `eligibleRiders()` helper
  (active + daily-capacity check) used by **both** `broadcast` and `rebroadcast`.
  Previously only `broadcast` checked capacity — `rebroadcast` would offer a job to a
  rider who was already at their daily job limit. Also wrapped rebroadcast's offer
  creation in a `$transaction` (broadcast already had one) and added a `job.state`
  realtime broadcast on offer-accept (parity with `assignJob`'s pattern — the job
  detail/tracking view now gets a live update on offer-accept the same way it does on
  manual assignment).
- Confirmed (did not need to change): `assign.ts` conditionally claims the job
  (`updateMany` gated on `status: from, riderId: oldRiderId`) and withdraws open
  offers for the job in the same transaction; `offers.ts`'s accept route does the
  mirror-image conditional claim gated on `status: "new", riderId: null`. Because both
  paths gate on the job's current row state inside a transaction, a rider-accept and a
  dispatcher-assign racing the same job can't both win — proven by the concurrency
  test below, not just asserted.

## Stage 2 — done (this session)

New: `apps/api/test/offers.test.ts` (8 tests) + `apps/api/test/helpers/test-app.ts`
(a real Fastify app + a real, disposable per-run sqlite db — not mocks — so the
concurrency tests race actual Prisma transactions against each other).

1. Two riders racing to accept the same broadcast set — exactly one 200, one 409,
   exactly one `RiderAssignment` row.
2. A rider's offer-accept racing a dispatcher's direct assignment on the same job —
   exactly one wins, never both.
3. Eligibility: a rider at daily capacity is excluded from both broadcast **and**
   rebroadcast (this is the regression test for the Stage 1 fix).
4. Expiration: an expired offer can't be accepted, and read routes lazily sweep it to
   `status: "expired"`.
5. Withdrawal: a withdrawn offer can't be accepted.
6. Authorization: unauthenticated broadcast → 401; rider-role broadcast → 403; a
   rider accepting another rider's offer → 409, offer left untouched.

Run: `cd apps/api && npx vitest run test/offers.test.ts` (or `npm run test:unit` for
the full suite). Uses `apps/api/data/test-offers.db`, created and deleted by the test
itself — safe to re-run any time, never touches `dev.db`.

## Verified gates (this session, actual output, not assumed)

| Command (working dir) | Result |
| --- | --- |
| `npm run typecheck --workspace @ronmacrae/api` | PASS — 0 errors |
| `npm run test:unit --workspace @ronmacrae/api` | PASS — 6 files, **35/35** (27 pre-existing + 8 new offers tests) |
| `npm run typecheck --workspace @ronmacrae/web` | PASS — 0 errors |
| `npm run test:unit --workspace @ronmacrae/web` | PASS — 1 file, 3/3 |
| `npm run build --workspace @ronmacrae/web` | PASS — 265.16 kB JS (gzip 79.20 kB), PWA generated |

E2e (`e2e/`) was **not** re-run this session — no web/UI changes were made, so the
existing Playwright specs are unaffected, but they haven't been re-verified against
this exact commit. Re-run before trusting them: `cd e2e && CI=1 npx playwright test`.

## A latent bug found (documented, deliberately NOT fixed — out of scope)

`apps/api/src/config.ts`, `effectiveDatabaseUrl()` (and the equivalent logic in
`apps/api/scripts/prepare-db.mjs`): the regex that strips `"file:"` off a `DATABASE_URL`
also eats one following `/`, so an **absolute** `file:/abs/path` URL gets detected as
NOT absolute (its leading `/` is gone) and `apiRoot` gets prepended a second time,
producing a broken doubled path. This only bites if `DEV_DB=1` and `DATABASE_URL` is
set to an absolute `file:/...` path (the app's own `.env`/dev flow uses a relative
`file:./data/dev.db`, which doesn't hit the bug, and prepare-db.mjs's own generated
default also isn't affected in the common case). The Stage 1/2 test harness sidesteps
it by using a relative URL, matching the app's existing convention, rather than
patching unrelated config code mid-task. Worth a 2-line fix later:
`cfg.DATABASE_URL.replace(/^file:\/?/, "")` → `cfg.DATABASE_URL.replace(/^file:/, "")`
in both places — the `if (rel.startsWith("/")) return cfg.DATABASE_URL` line then
works correctly for absolute paths.

## A DTO gap worth knowing about before Stage 3 (UI)

`JobOfferDto` (`packages/contracts/src/types.ts`) does not include `riderId` or a
rider name/label. That's fine for the rider-facing routes (a rider only ever sees
their own offers). But the **dispatcher-facing** `GET /api/jobs/:id/offers` needs to
show which rider each offer went to, and the current DTO can't express that. Stage 3
will need to either add a rider-identifying field to `JobOfferDto` (contracts change)
or have the dispatcher offers list use a separate, staff-only DTO shape. Decide this
before starting the offers UI.

## Exact next steps (Stage 3 first)

1. **Dispatcher UI**: on the existing Jobs screen (`apps/web/src/pages/jobs.tsx`),
   add a broadcast/rebroadcast/withdraw action per unassigned `new` job (calls the
   existing `/api/jobs/:id/offers/*` routes) and an offers panel showing status per
   rider — needs the DTO decision above first.
2. **Rider UI**: on `apps/web/src/pages/rider-dashboard.tsx`, add an offers section
   (poll or hub-push `type: "offer"` messages already broadcast by `offers.ts`) with
   Accept/Decline buttons hitting `/api/bearer/offers/:id/accept|decline`.
3. Typecheck + build + a focused e2e spec for the offer flow before calling Stage 3
   done — do not mark it complete without running those gates and recording actual
   output here, the way Stage 1/2 did above.
4. Then Stage 4 (alerts/push), Stage 5 (GPS/maps/tracking), Stage 6 (final full-suite
   gates + preview instructions).

No map provider, credentials, billing action, deploy, or notification/location
behavior was added or claimed as delivered in this session.

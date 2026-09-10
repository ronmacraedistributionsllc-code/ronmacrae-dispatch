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
  `JobOffer` table push) is still present and byte-identical — that's the pre-existing
  DB backup from the OpenCode session, kept as a rollback point for the schema change.
  `apps/api/data/dev.db` was untouched through Stage 1/2 (those tests run against an
  isolated, disposable `apps/api/data/test-*.db`), but Stage 3's e2e run did grow it
  with new seeded/test jobs and riders (`CI=1 npx playwright test` reseeds via `npm
  run seed`, then accumulates jobs as specs run) — same disposable-accumulation
  pattern every prior checkpoint in this file already documents, not new behavior.
  No backup was taken before Stage 3 because no schema change happened; `dev.db` is
  disposable data, not a migration point, per the existing project convention.
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
| 3 | Dispatcher broadcast/assign UI + rider Accept/Decline cards | **DONE** — see below |
| 4 | Live in-app alerts + opt-in browser push | **NOT STARTED** |
| 5 | Foreground GPS, dispatcher maps, secure customer tracking | **NOT STARTED** |
| 6 | Full workflow tests, typecheck, build, preview instructions | **PARTIAL** — backend + Stage 3 UI gates green (see below); Stage 6 still needs Stages 4-5 done first |

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

## Stage 3 — done (this session)

**Contracts change**: `JobOfferDto` (`packages/contracts/src/types.ts`) gained optional
`riderId?`/`riderName?`, populated only on staff-facing routes (broadcast, rebroadcast,
`GET /api/jobs/:id/offers`) via a `dto(row, { includeRider: true })` flag in
`apps/api/src/modules/offers.ts` — the rider-facing routes (`GET /api/bearer/offers`,
accept, decline) omit them, unchanged. This was the gap flagged at the end of Stage 2.
Remember to rebuild contracts (`npm run build --workspace @ronmacrae/contracts`) after
editing `packages/contracts/src` — apps import the built `dist`, not `src`, and a stale
dist has bitten this project before (see the Phase 2 checkpoint's "stale dist" note).

**Dispatcher UI** (`apps/web/src/pages/jobs.tsx` + new
`apps/web/src/components/job-offers-panel.tsx`): an "Offers" toggle button on each
unassigned (`new`) job row expands a panel with Broadcast / Broadcast-again /
Rebroadcast controls (expiry-minutes input) and a live (10s-polled) list of offers per
rider with status badges and a Withdraw button on open ones. No manual rider-picking
UI in the broadcast form — it always broadcasts to every eligible (active, available,
under daily capacity) rider, matching the API's existing `eligibleRiders()` behavior;
manual single-rider assignment (the pre-existing Assign/Reassign control) is unchanged
and still the way to hand a job to one specific rider directly.

**Rider UI** (`apps/web/src/pages/rider-dashboard.tsx`): a "Job offers" section above
"My deliveries", polling `GET /api/bearer/offers` every 8s, rendering pickup →
destination, item summary, rider earnings/delivery fee/COD amount, and a countdown to
expiry, with Accept/Decline buttons. Accept surfaces the server's 409 ("Another rider
has already claimed this job") as an inline error if lost to a race, and refetches
both the offers and assigned-jobs lists either way.

**New e2e spec** `e2e/specs/offers.spec.ts` (2 tests, real browser, two separate
browser contexts for the dispatcher and rider sides):
1. Dispatcher broadcasts via the Jobs screen UI → a dedicated fresh test rider (not
   the shared seeded "Kei Bearer", to stay immune to other specs' parallel-worker
   state) sees and accepts the offer from their dashboard UI → the dispatcher's Jobs
   screen shows the job assigned to that rider on reload.
2. A dispatcher-withdrawn offer never appears on the rider's dashboard.

Two real bugs were caught and fixed while getting this spec green (both test-only,
no production code changes were needed for them):
- A login-then-navigate race (`page.goto("/jobs")` fired before the login redirect
  had actually completed) — fixed by waiting for the post-login heading first.
- The accumulated `dev.db` has many `new` jobs and several stale same-named
  "Offer Test Rider" rows left over from earlier failed attempts at this exact spec
  (each retry creates a fresh rider via the API and never cleans it up) — an unscoped
  text locator was ambiguous. Fixed by adding `data-testid`s
  (`offers-panel-<jobId>`, `offer-rider-<riderId>`) and scoping locators by id instead
  of display text.

## Verified gates (this session, actual output, not assumed)

| Command (working dir) | Result |
| --- | --- |
| `npm run typecheck --workspace @ronmacrae/api` | PASS — 0 errors |
| `npm run test:unit --workspace @ronmacrae/api` | PASS — 6 files, **35/35** (27 pre-existing + 8 offers tests) |
| `npm run typecheck --workspace @ronmacrae/web` | PASS — 0 errors |
| `npm run test:unit --workspace @ronmacrae/web` | PASS — 1 file, 3/3 |
| `npm run build --workspace @ronmacrae/web` | PASS — 271.28 kB JS (gzip 80.84 kB), PWA generated |
| `npm run build --workspace @ronmacrae/contracts` | PASS |
| `cd e2e && CI=1 npx playwright test` | PASS — **12/12** (10 pre-existing + 2 new offers specs) |
| `npm run lint` (repo root) | **8 pre-existing errors**, all in files this session never touched (`apps/api/src/modules/jobs/proofs.ts`, `repository.ts`, `transition.ts`, `settings.ts`, `tracking.ts` — unused imports). Not a regression; lint was not part of any previously-passing checkpoint gate. Worth cleaning up separately. |

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

## Exact next steps (Stage 4 next)

1. **Realtime client**: the web app has zero websocket client today — `ctx.hub`
   (`apps/api/src/rt/hub.ts`) already broadcasts `type: "offer"`, `"job.assigned"`,
   and `"job.state"` messages over `WS_PATH` (`/ws`, token as a query param — see
   `packages/contracts/src/routes.ts`), but nothing on the frontend connects to it.
   Stage 3's offer UI works today via polling (8-10s intervals) as an interim, so
   Stage 4's real job is building a `useRealtimeHub`-style hook (connect, auth,
   reconnect/backoff, dispatch typed messages to subscribers) and wiring the offers
   panel/cards to it instead of polling — plus a toast/badge for new offers and other
   dispatcher-relevant events.
2. **Opt-in browser push**: needs a service worker push handler (the PWA already has
   `vite-plugin-pwa` generating `sw.js` — check whether its `generateSW` mode allows
   a custom push listener or whether this needs `injectManifest` mode instead), a
   subscription-storage table (new Prisma model), a `web-push`-style VAPID key pair
   (self-generated, no paid service — do **not** set up Firebase/OneSignal/etc.
   without asking first, per the no-new-billing constraint), and an explicit
   opt-in control in the UI (never auto-subscribe).
3. Typecheck + build + an e2e spec proving the realtime path (e.g. two browser
   contexts, one broadcasts, the other sees the offer appear without a manual
   reload/refetch) before calling Stage 4 done.
4. Then Stage 5 (GPS/maps/tracking), Stage 6 (final full-suite gates + preview
   instructions).

No map provider, credentials, billing action, deploy, or notification/location
behavior was added or claimed as delivered in this session.

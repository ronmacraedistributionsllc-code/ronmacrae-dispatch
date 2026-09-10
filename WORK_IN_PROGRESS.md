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
| 4 | Live in-app alerts + opt-in browser push | **DONE** — see below |
| 5 | Foreground GPS, dispatcher maps, secure customer tracking | **NOT STARTED** |
| 6 | Full workflow tests, typecheck, build, preview instructions | **PARTIAL** — backend + Stage 3/4 gates green (see below); Stage 6 still needs Stage 5 done first |

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

## Stage 4 — done (this session)

**Realtime client** (new `apps/web/src/lib/realtime.tsx`): the web app had zero
websocket client before this — `RealtimeProvider` connects to the existing hub
(`apps/api/src/rt/hub.ts`, `GET /ws?token=`), reconnects with exponential backoff
(capped 30s) on drop, and refreshes the access token via `POST /auth/refresh` on a
`4401` (stale-token) close before reconnecting. Mounted once in `app.tsx` inside
`AuthProvider`. `useRealtime().subscribe(types, handler)` lets any component listen
for specific message types. Polling is kept everywhere as a fallback (interval
relaxed from 8-10s to 20s now that realtime covers the common case) — a dropped
websocket connection degrades to "20s-stale" rather than "silently stuck forever".

**Contracts**: added `"offer"` to the formal `RealtimeMessage` union (it existed at
runtime already via the hub's looser `AnyRtMessage` type but wasn't in the typed
contract). Rebuilt.

**In-app alerts** (new `apps/web/src/components/alerts-toaster.tsx`, mounted in
`layout.tsx` so it's global): a toast stack — riders see "New delivery offer…" on
`offer` messages, staff see "`<job>` assigned to `<rider>`" on `job.assigned` and a
red SOS toast on `sos`. Auto-dismisses after 7s.

**Live-wired UI**: `apps/web/src/components/job-offers-panel.tsx` (dispatcher) now
also broadcasts newly-created offers to the dispatch room
(`apps/api/src/modules/offers.ts`'s `createOffers`, staff-shaped dto with
`riderId`/`riderName`) and subscribes to `offer`/`job.assigned` for its own job id to
invalidate immediately; `rider-dashboard.tsx` subscribes to `offer` to invalidate the
offers list immediately. **Not yet wired**: decline/withdraw don't push a dispatch
update (poll-only for now — a real but small gap, noted rather than hidden).

**Opt-in browser push** (Web Push / VAPID):
- Schema: new `PushSubscription` model (`apps/api/prisma/schema.prisma`) — backed up
  `dev.db` first (`apps/api/data/dev.db.bak-push-<timestamp>`), pushed additively
  (24 → 25 tables, confirmed via table-name diff, no data-loss warning).
- Config (`apps/api/src/config.ts`): `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`,
  same dev-fallback pattern as `SESSION_SECRET` — a well-known dev-only key pair when
  `DEV_DB=1`, required (no default) otherwise. Documented in `.env.example`.
- New `apps/api/src/modules/push.ts` (`PushService` + `pushRoutes`): `GET
  /api/push/public-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe` (all
  `requireAuth`; unsubscribe is scoped to the caller's own `userId`, not just the
  endpoint — tested). `sendToUser`/`sendToRider` are best-effort (never throw into the
  caller; a `404`/`410` from the push service prunes the stale subscription row) and
  wired into `offers.ts`'s `createOffers`, so every rider offered a job also gets a
  push (title/body/tag/url) even if the app is backgrounded or closed.
- `web-push` + `@types/web-push` added to `apps/api`. No new production vulnerability
  (`npm audit --omit=dev` before/after: same 3 pre-existing, unrelated advisories —
  `deepmerge-ts`/prisma, `maplibre-gl`, `react-router`).
- Frontend: `apps/web/src/sw.ts` (new, hand-written service worker with `push` and
  `notificationclick` handlers) required switching `vite-plugin-pwa` from
  `generateSW` to `strategies: "injectManifest"` (`vite.config.ts`) — verified the
  build still precaches everything (10 entries now vs. 7 before; the count changed
  because `injectManifest`'s glob enumerates differently, not because anything is
  missing) and typechecks in its own `tsconfig.sw.json` (DOM and WebWorker lib types
  conflict, so it's excluded from the main `tsconfig.json` and typechecked
  separately — wired into `npm run typecheck`).
- `apps/web/src/components/push-opt-in.tsx`: explicit opt-in toggle (never
  auto-subscribes), reflects the browser's actual subscription state on mount (not
  just local state). Wired into the rider dashboard only — push is currently
  rider-only (the only send trigger is offer broadcast), so a dispatcher-facing
  toggle would opt in to nothing; noted rather than added as a dead end.

**New tests**:
- `apps/api/test/push.test.ts` (8 tests): auth required on all three routes,
  validation, subscribe-is-an-upsert, and — the one that actually matters for
  security — unsubscribe is scoped by `userId`, so one user's request can't delete
  another user's subscription even knowing its `endpoint`.
- `e2e/specs/realtime.spec.ts` (2 tests): a rider's **already-open** dashboard (opened
  before the offer exists) shows a new offer within a 5s assertion timeout — well
  under the 20s poll interval, so a passing run is real evidence of the websocket
  path, not poll-timing luck. Same proof for the dispatcher's offers panel updating
  live on accept.
- `e2e/specs/push-optin.spec.ts` (1 test): covers everything this app is responsible
  for — permission flow, and that `/api/push/subscribe`/`unsubscribe` really
  round-trip (asserted on the actual network responses, not just resulting button
  text) — while stubbing `navigator.serviceWorker.ready`'s `pushManager` so the test
  doesn't depend on a real browser-vendor push service (out of scope: that's
  Chrome's/Firefox's infrastructure, not this app's).
- **Deliberately not claimed**: actual push delivery to a real device is not, and
  cannot reasonably be, proven by an automated test here — this app's opt-in
  mechanics and its own API surface are what's tested; the third-party push service
  is stubbed, not exercised for real. Manual verification: run the preview build,
  click "Enable push notifications" as a real rider in a real browser, have a
  dispatcher broadcast an offer, confirm the OS notification appears.

## Verified gates (this session, actual output, not assumed)

| Command (working dir) | Result |
| --- | --- |
| `npm run typecheck --workspace @ronmacrae/api` | PASS — 0 errors |
| `npm run test:unit --workspace @ronmacrae/api` | PASS — 7 files, **45/45** (27 original + 8 offers + 8 push + 2 new config tests) |
| `npm run typecheck --workspace @ronmacrae/web` | PASS — 0 errors (app tsconfig + standalone `sw.ts` tsconfig) |
| `npm run test:unit --workspace @ronmacrae/web` | PASS — 1 file, 3/3 |
| `npm run build --workspace @ronmacrae/web` | PASS — 278.24 kB JS (gzip 82.97 kB), `injectManifest` PWA, 10 precache entries, `dist/sw.js` confirmed to contain `push`/`notificationclick` handlers |
| `npm run build --workspace @ronmacrae/contracts` | PASS |
| `cd e2e && CI=1 npx playwright test` | PASS — **15/15** (12 pre-existing + 3 new: 2 realtime, 1 push opt-in) |
| `npm run lint` (repo root) | Same **8 pre-existing errors**, all in files this session never touched — unchanged from Stage 3, not a regression |
| `npm audit --omit=dev` (repo root) | Same 3 pre-existing production advisories as before `web-push` was added (deepmerge-ts/prisma, maplibre-gl, react-router) — no new one |

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

## Exact next steps (Stage 5 next)

1. **Foreground GPS**: the rider dashboard has no location capture at all yet. Add
   opt-in foreground geolocation (`navigator.geolocation.watchPosition`, only while
   the tab is open/visible — explicitly do **not** claim reliable background
   tracking from a PWA, per the constraint) that posts to the existing
   `POST /api/rider-locations/:id/report` route (`apps/api/src/modules/riders.ts:299`)
   already registered and already storing `RiderLocation` rows. Show the rider
   plainly when their last report was sent (staleness is honest UI, not hidden).
2. **Dispatcher map**: `maplibre-gl` is already a web dependency (added by an earlier
   session, unused so far — check whether a tile source needs picking: a keyless
   provider like OSM raster tiles, or reuse whatever `@ronmacrae/geo`'s existing
   `GOOGLE_MAPS_API_KEY`-optional fallback already resolves to for consistency).
   Live rider markers should come from the realtime hub's `rider.location` message
   type (already in the `RealtimeMessage` union, already broadcast somewhere in
   `rt/location-sim.ts` presumably — check it before assuming), wired through
   `useRealtime()` (Stage 4's client) rather than a new polling loop.
3. **Secure customer tracking**: check `apps/api/src/modules/tracking.ts` and
   `apps/web/src/pages/track.tsx` (or wherever `/track/:token` renders) for what
   exists today before adding anything — the checkpoint history mentions tracking
   links already work for the booking flow; Stage 5's job is adding live position to
   that page (if not already present) without ever exposing more than an
   approximate/last-known point, and showing staleness honestly (no fake "live"
   badge on a location that's minutes old).
4. Typecheck + build + an e2e spec for whichever of the above is added, before
   calling Stage 5 done — same standard as every stage so far.
5. Then Stage 6: run every gate (api, web, e2e, lint, audit) together one final
   time, and write the actual preview/demo instructions (`npm run dev`, seeded
   creds, `WEB_DIST` preview mode) into the checkpoint doc.

No map provider, credentials, billing action, deploy, or notification/location
behavior beyond what's listed above as done was added or claimed as delivered in
this session.

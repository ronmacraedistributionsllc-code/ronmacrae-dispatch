# Work in progress — offers/GPS/alerts handoff (resumed by Claude Code, 2026-09-10)

**All 6 originally-requested stages were DONE and verified (see below), then a 7th
round of revisions was requested during manual testing** — address-first order
creation, owner-only delivery-fee zones, alert refinements, e2e/dev-db isolation,
and a dev-db order cleanup. See "Stage 7" further down for that work; it's also
DONE and verified. This file is kept as the detailed record of what was actually
found/built/tested at each stage — `PHASE1_JOBS_CHECKPOINT.md` has the final
combined gate results and the preview/demo instructions a reviewer or the next
builder actually needs. Read this file when you need the "why" behind a decision;
read the checkpoint for the "does it work" proof.

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
| 5 | Foreground GPS, dispatcher maps, secure customer tracking | **DONE** — see below |
| 6 | Full workflow tests, typecheck, build, preview instructions | **DONE** — full combined gate run (root `typecheck`/`test:unit`/`build`/`lint`/`audit`) plus the built preview server actually booted, all 5 demo logins tested for real, and verified instructions written into the checkpoint |

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

## Stage 5 — done (this session)

**A real gap found and fixed before adding anything**: `RidersService.reportLocation`
(`apps/api/src/modules/riders.ts`, real GPS reports) never stopped an in-progress
simulated leg (`LocationSimulator`, `apps/api/src/rt/location-sim.ts`) for the same
rider's active job. The simulator's own docstring already claimed "the web bearer
app can override the simulation with real GPS" — the code just didn't do it. Fixed
with one line (`if (job) this.app.sim.stopForJob(job.id)`) before writing the real
point, so a real report now reliably wins instead of getting overwritten by the
sim's next 5s tick.

**Foreground GPS** (new `apps/web/src/lib/geolocation.ts` +
`apps/web/src/components/location-sharing.tsx`, wired into the rider dashboard):
explicit opt-in `watchPosition`, throttled to one report per 8s, posting to the
already-registered `POST /api/rider-locations/:id/report`. Foreground-only is
enforced structurally, not just claimed: a `visibilitychange` listener **clears**
the watch (not just throttles it) the instant the tab is hidden, flips the state to
"paused", and requires the rider to explicitly tap "Resume sharing" when they
return — there is no code path that claims to still be tracking in the background.

**Dispatcher map** (new `apps/web/src/pages/map.tsx`, code-split via `React.lazy`
since `maplibre-gl` is ~1MB and only staff visiting `/map` need it): live rider
markers from the realtime `rider.location` message (Stage 4's client) plus a new
`GET /api/rider-locations` bootstrap endpoint (`apps/api/src/modules/riders.ts`,
`RidersService.latestLocations()` — bounded to the last 24h so it never has to scan
the ever-growing full history table) for the initial render before any realtime
message arrives. Tiles are keyless OpenStreetMap raster (`apps/web/src/lib/map-style.ts`,
shared with the customer tracking map below) — same "no API key" convention
`packages/geo`'s geocoding fallback already uses. Each marker's colour and the
riders list both surface `trackingState` and a relative "how long ago" — staleness
is visible, not hidden, and the view doesn't distinguish (or claim to) whether a
point came from real GPS or the preview simulator.

**Secure customer tracking**: the public `/track/:token` page
(`apps/api/src/modules/tracking.ts`, `apps/web/src/pages/track.tsx`) already existed
and already handled the honesty requirement well — `trackingState` and a "last
update" timestamp were already shown, the delivery PIN was already gated to
in-transit-ish statuses only, and the link itself already expires/can be revoked.
What Stage 5 added: a small read-only map (new `apps/web/src/components/courier-map.tsx`,
also lazy-loaded) showing the courier's last known point, rendered only when a
point exists — nothing else about the security model needed changing.

**A pre-existing dangling contract, noted not fixed**: `packages/contracts/src/routes.ts`
already declared `API.riders.locationsFor(riderId)` (presumably meant as a per-rider
location-history endpoint) with no backend route ever implemented for it. Stage 5's
own new endpoint (`API.riders.locations`, the aggregate "latest per rider" list) was
also pre-declared and is now finally backed — `locationsFor` remains dangling; out of
scope here since nothing in this stage needed per-rider history.

**Found and fixed while verifying, not part of the plan**: `maplibre-gl` was a
pre-existing, previously-*unused* dependency carrying a **critical** XSS advisory
(`GHSA-jrc7-96c5-q579`, sanitizer bypass, fixed in 6.9.0). Activating it into the
live render path (this stage) changes that from "dormant" to "shipped, exploitable
surface" — so rather than just noting it, upgraded `5.24.0 → ^6.9.0`. This app's own
usage (`Popup.setText()`, never `.setHTML()` with untrusted content) very likely
wasn't on the vulnerable code path even before upgrading, but there was no reason to
leave a critical advisory in place once it mattered. Verified: typecheck clean, web
build clean, and — the real proof, since this is a major version bump — the full e2e
suite still passes 17/17 including both map specs, which actually render
`.maplibregl-canvas` and a marker popup. `npm audit --omit=dev` now shows 5
vulnerabilities (0 critical), down from 6; the remaining ones (`deepmerge-ts`/prisma,
`react-router`) are unrelated and still out of scope (breaking-change fixes, not
touched).

**Also found, NOT fixed (much lower stakes, explicitly out of scope)**: the same
`jobs.spec.ts` e2e spec's rider-picker assertion assumed the seeded "Kei Bearer" is
always dropdown option index 1. `RidersService.list()` orders riders alphabetically
by name, and this session's own test-created riders (e.g. "GPS Test Rider" — "G"
sorts before "K") pushed Kei out of that position, breaking the test. This one *was*
fixed (not just noted) since it's a test-file change, not production code: the spec
now selects by finding the `<option>` whose text starts with "Kei Bearer" and
selecting its value, robust to both ordering and the status-suffix in the label.

## Verified gates (this session, actual output, not assumed)

| Command (working dir) | Result |
| --- | --- |
| `npm run typecheck --workspace @ronmacrae/api` | PASS — 0 errors |
| `npm run test:unit --workspace @ronmacrae/api` | PASS — 7 files, **45/45** |
| `npm run typecheck --workspace @ronmacrae/web` | PASS — 0 errors (app tsconfig + standalone `sw.ts` tsconfig) |
| `npm run test:unit --workspace @ronmacrae/web` | PASS — 1 file, 3/3 |
| `npm run build --workspace @ronmacrae/web` | PASS — main bundle back to ~282 kB (map code-split into its own ~1MB chunk, loaded only on `/map` or when a tracking page has a courier point) |
| `npm run build --workspace @ronmacrae/contracts` | PASS |
| `cd e2e && CI=1 npx playwright test` | PASS — **17/17** (12 prior + 3 GPS/map + jobs.spec.ts fix) |
| `npm run lint` (repo root) | Same **8 pre-existing errors**, all in files this session never touched — unchanged since Stage 3, not a regression |
| `npm audit --omit=dev` (repo root) | **5 vulnerabilities, 0 critical** (was 6 with 1 critical before the `maplibre-gl` upgrade) — the remaining 5 (`deepmerge-ts`/prisma, `react-router`) are pre-existing, unrelated, breaking-change fixes, still out of scope |

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

## Stage 6 — done (this session)

Ran every gate fresh, in one combined pass, from the repo root (not the per-workspace
commands used during individual stages — the root `npm run typecheck`/`test:unit`/
`build` scripts fan out to every workspace, so this is the actual "does the whole
thing work together" check): 0 typecheck errors anywhere, unit **45/45** (api) +
**3/3** (web) + **8/8** (contracts/geo/money) + **6/6** (notifications), **e2e 17/17**
(the root `test:unit` script runs Playwright too, since `@ronmacrae/e2e`'s own
`test:unit` is aliased to it), build clean across every workspace including
`apps/api`'s `dist/main.js`. Lint: the same 8 pre-existing errors, unchanged. Audit:
5 vulnerabilities, 0 critical.

Then — not just built, actually **booted and exercised** — ran the real `make
preview` flow (`npm run build --workspace @ronmacrae/web` +
`WEB_DIST=... npm run preview:api`), confirmed `/api/health` reports the built PWA
is being served, tested all 5 seeded demo logins for real against the running
server (not assumed from reading `seed.ts`), hit `/map` and two Stage 4/5 API routes
with a real token, then stopped it cleanly. Full verified preview instructions,
demo credentials table, and a per-stage "where to look" guide are now in
`PHASE1_JOBS_CHECKPOINT.md`'s Stage 6 section — that's the file to hand a human
reviewer.

Also folded every open item from Stages 1-5 into one consolidated "Known issues"
list in the checkpoint (the `effectiveDatabaseUrl` path-doubling bug, the dangling
`locationsFor` contract route, the 8 lint errors, and the `deepmerge-ts`/`react-router`
audit advisories) so nobody has to reconstruct it from six stages of session notes.

Native mobile app remains explicitly out of scope, as the user asked from the start.

No map provider, credentials, billing action, or deploy was added at any point in
this session. Everything above was actually run and its real output recorded — see
`PHASE1_JOBS_CHECKPOINT.md` for the exact commands and results.

---

# Stage 7 — address-first order creation, owner-only fee zones, alert refinements,
# dev-db cleanup (Claude Code, 2026-09-10)

Requested after Stage 6's manual-testing walkthrough began: revise order creation,
add owner-only delivery-fee zone management, tighten courier alerts, isolate
automated tests from the live dev db, and clean out its accumulated test orders.
Preserved: the completed delivery workflow, all prior commits, users, roles, zones
(the rows — their *editability* changed), and configuration.

## 1. Address-first order creation

New `apps/web/src/components/address-picker.tsx` + `pin-map.tsx`: search → ranked
suggestions → map with a **draggable** pin → explicit **"Confirm location"** required
before the value updates. Backed by two new public (rate-limited, same convention as
`/api/quotes/public`) routes in new `apps/api/src/modules/geo.ts`:
`POST /api/geo/geocode` (multi-result search — `packages/geo`'s `GeoProvider.geocode()`
only ever returned one match, so added `searchAddresses()` to the interface,
implemented for real in `OsmProvider` via Nominatim's own multi-result support, and
composed through the existing failover chain in `CompositeGeoProvider`) and
`POST /api/geo/reverse` (label a dragged pin).

**Both failure modes the request called out are handled, not just hoped away:**
- *Address search unavailable*: the existing deterministic offline fallback
  (`SimulatedProvider`, already the last link in the geocode failover chain) still
  returns a result so the order isn't blocked, but the response now carries a
  `degraded: true` flag the picker surfaces as a visible amber banner — never
  silently presented as a normal match.
- *Map/tiles failing to load*: `AddressPicker` wraps the map in a small class-based
  error boundary (`MapErrorBoundary` — React has no hook for this) that falls back to
  a coordinates-only confirmation, so a tile-load failure doesn't block booking.

`new-job.tsx` was rewritten around this: **Step 1 is the destination address**, and
the rest of the form (customer, pickup, product, timing, payment) is hidden until
it's confirmed. Customer name is now **First name** (required) / **Last name**
(optional, concatenated server-side into the existing single `Customer.name`
field — no schema change, since every other view already reads `customer.name`).
Pickup defaults to **15-17 Half Way Tree Road, Kingston, Jamaica** (geocoded once on
load) and is edited through the identical AddressPicker flow; the destination is
shown a second time in the "Pickup & destination" section, bound to the *same*
state as Step 1's picker, so editing it there uses the identical flow without extra
plumbing. Requested delivery is now a **date-only** `<input type="date">` (no
clickable time) plus an **"Urgent delivery"** checkbox — replacing the old
Normal/Express/Urgent select in this form (the `express` priority value still
exists in the schema/enum for other paths; this form just no longer exposes it).
Delivery fee auto-suggests from the real fare engine (`POST /api/quotes` with both
confirmed points + the urgent flag) once both pickup and destination are known, and
stays editable — typing in the field stops the auto-fill from overwriting it again.

## 2. Owner-only delivery-fee zones

`Zone` gained `urgentSurchargeFee Int?` (additive migration — `dev.db` backed up
first as `dev.db.bak-prefeature-<timestamp>`, confirmed additive: table count
unchanged, only a new nullable column). `apps/api/src/modules/zones.ts`: zone
**create/update/delete are now `admin`-only** (were `admin`+`dispatcher`) —
dispatchers keep read access (they still need zones for order entry/quoting) but
can no longer create, edit, enable/disable, or delete one; delete refuses (409) if
any Job references the zone ("disable it instead" — no silent data loss). Creating
a zone now accepts a `center` point (from the same AddressPicker, reused a third
time) instead of requiring a hand-drawn polygon — a small square coverage area is
generated around it via a new shared `squareZoneGeometry()` helper in
`packages/geo` (the same shape `seed.ts` already used for the seeded zones, now
shared rather than duplicated). `FareEngine.quote()` applies the destination zone's
flat `urgentSurchargeFee` when `urgent: true` is passed, alongside the existing
express/heavy/night percentage surcharges. New admin-only UI:
`apps/web/src/components/zone-manager.tsx`, shown only to `role === "admin"` on the
Zones & Fares page; the existing read-only zones table/quote tool stays for
dispatchers. Tests: `apps/api/test/zones.test.ts` (8 tests) — the permission
boundary (dispatcher 403 / admin 200 on every write route) and the delete-refuses-
with-orders-attached case are the ones that actually matter here, and are covered.

## 3. Courier alerts refined

Three real gaps found and fixed:
- **Direct assignment never pushed or carried enough info to alert correctly.**
  `assign.ts`'s `job.assigned` broadcast gained a `source: "assign"` field (offers'
  own accept path sets `source: "offer"`) so the frontend can tell "you were
  assigned" apart from "you just accepted your own offer" (the latter doesn't need
  a redundant toast). Wired `ctx.push.sendToRider()` into direct assignment too —
  previously only offer-broadcast sent a push at all.
- **No unread indicator existed.** `lib/realtime.tsx`'s `RealtimeProvider` now
  tracks `unreadCount`/`markRead()`, incrementing on the same alert-worthy-message
  rule `alerts-toaster.tsx` already used for toasts (kept in one place,
  `isAlertWorthy()`, so the badge and the toasts can never disagree). Shown as a
  small red badge on the Dashboard nav tab; cleared on navigation (coarse but
  simple and honest — no per-item read-tracking to get subtly wrong).
- **Urgent priority had no visual prominence anywhere it's seen.** Added a red
  "Urgent" badge to the dispatcher Jobs table row, the rider's job card, the
  rider's offer card, and the dispatcher's offer-list row — `JobOfferDto` gained a
  `urgent: boolean` field for the offer-card cases.

Content privacy is unchanged and re-verified: neither the toast text nor the push
payload (for either broadcast or direct assignment) includes customer phone, name,
or the delivery PIN — both still send only pickup/destination-area text.

New e2e: `e2e/specs/alerts.spec.ts` — a direct assignment alerts (toast + unread
badge) the assigned rider within ~5s and, over a 2s window, never reaches an
uninvolved rider who's logged in and watching at the same time. **Caught a real,
separate bug while writing this test** (see below).

## 4. E2e/dev-db isolation

`e2e/playwright.config.ts`'s `webServer` now sets `DATABASE_URL: "file:./data/e2e-test.db"`
— e2e runs (including every future one) now use their own disposable sqlite file,
never `apps/api/data/dev.db`. This was an explicit ask ("do not repopulate the live
development database") and also fixes the root cause of a fragility this session
hit twice before (Stage 3, Stage 5): accumulated same-named/same-position test
riders from e2e runs subtly breaking other tests or polluting what a human sees in
the manual-preview `dev.db`. Verified: ran a spec, confirmed `dev.db`'s mtime was
unchanged and a new `e2e-test.db` appeared instead.

**A real bug found and fixed while debugging `alerts.spec.ts`'s flakiness under
full-parallel-suite load** (this is the one worth reading closely): `RidersService.create()`
(`apps/api/src/modules/riders.ts`) hardcodes every newly-created rider to
`status: "available"` at creation, regardless of the Prisma schema's own
`@default(offline)`. A test's "uninvolved rider" fixture — created but deliberately
left alone, expecting it to start `offline` per the schema default — was actually
`available` from the moment of creation, making it silently eligible for *any other,
concurrently-running spec's* unscoped "broadcast to all eligible riders" (like
`offers.spec.ts`'s UI-driven broadcast test) and occasionally picking up a real
alert that had nothing to do with the test being run. First fix attempt (removing an
explicit status-PATCH call, based on the wrong assumption that offline was already
the default) didn't help and the test kept failing under full-suite parallel load
even though it passed 3/3 in isolation — the actual fix was an explicit
`PATCH .../status {status:"offline"}` immediately after creation. Verified stable
across 3 consecutive full-suite runs after the real fix (was reproducing on
essentially every full-suite run before it). This is a real, if minor, production
behavior worth knowing about too: `RidersService.create()`'s hardcoded
`status: "available"` means a freshly-created rider is immediately live/offerable
before anyone has confirmed they're actually on shift — not changed here (out of
scope for this task), but flagged in the Known Issues list below.

## 5. Dev-db order cleanup

Backed up `dev.db` again (`dev.db.bak-cleanup-<timestamp>`, taken *before* the
deletion, separate from the earlier pre-schema-change backup) and recorded exact
row counts before and after. Deleted all 126 accumulated `Job` rows via
`prisma.job.deleteMany({})`, relying on the schema's own cascade relations
(`JobEvent`, `JobOffer`, `RiderAssignment`, `TrackingLink`, `Proof`, `RouteStop` are
all `onDelete: Cascade` on `jobId`) rather than deleting each table by hand.
`OutboxMessage.jobId` has no FK at all and `SosAlert`/`PayoutLine`'s `jobId` are
`onDelete: SetNull` — neither blocks or needs separate handling. `AuditLog` and
`RiderLocation` were deliberately left untouched (not "order records" — a general
audit trail and general rider telemetry, respectively). Confirmed after: `Job` /
`JobEvent` / `JobOffer` / `RiderAssignment` / `TrackingLink` / `Proof` all `0`;
`User` (66) / `Rider` (62) / `Customer` (52) / `Zone` (3) / `FareRule` (1) /
`Setting` (1) / `PushSubscription` (1) all exactly unchanged from before. The
one-off cleanup script was run from a scratch location and deleted immediately
after — it's not part of the repo (this was a one-time operational task, not a
repeatable app feature).

## Verified gates (this session, actual output)

| Command | Result |
| --- | --- |
| `npm run typecheck` (root, all 6 workspaces) | PASS — 0 errors everywhere |
| `npm run test:unit` (root) | PASS — api **55/55** (45 prior + 8 zones + 2 new quotes urgent-surcharge tests), web 3/3, contracts/geo/money 8/8, notifications 6/6, **e2e 18/18** (17 prior + 1 new alerts spec) |
| `npm run build` (root) | PASS — all workspaces, including `apps/api`'s `dist/main.js` |
| `npm run lint` | Same 8 pre-existing errors, unchanged |
| `npm audit --omit=dev` | Same 5 vulnerabilities / 0 critical, unchanged (no new dependencies) |
| Full e2e suite, 3 consecutive full-parallel runs after the `RidersService.create()` fix | **18/18 every time** — the earlier flakiness is confirmed gone, not just retried away |

## Known issues (updated — folds in this stage's finding)

Everything from Stage 6's list still applies (`effectiveDatabaseUrl` path-doubling,
the dangling `locationsFor` contract route, the 8 lint errors, the
`deepmerge-ts`/`react-router` audit advisories), plus:

6. **`RidersService.create()` hardcodes `status: "available"`** on every new rider,
   ignoring the schema's own `@default(offline)`. In production this means a
   freshly-onboarded rider is immediately eligible for job offers before anyone —
   the rider or a dispatcher — has actually confirmed they're on shift and ready.
   Not fixed here (out of scope for this task, and changing it would need a design
   decision: should rider creation default to offline and require an explicit
   "I'm online" action, or is immediate availability the intended UX for onboarding
   a rider who's standing in the store ready to start?). Worth asking about
   before the next round of work.

---

# Pre-production hardening (Claude Code, 2026-09-10 — continuing)

Requested before production prep: fix address entry, rider multi-job capacity,
notification repair, safe test-rider cleanup, and 7 major operational features
(COD ledger, rider route queue, dispatcher ops board, customer notifications,
reports, emergency contact, delivery messaging). This is large enough that it's
being worked as its own sequence of bounded, individually-committed stages —
tracked here as Stages 8+ (Stages 1-7 above are the prior work, already shipped).

## Stage plan

| # | Stage | Status |
| - | ----- | ------ |
| 8 | Fix address entry (manual text is authoritative, never silently overwritten) | DONE |
| 9 | Rider availability toggle + configurable multi-job capacity | DONE |
| 10 | Diagnose and repair rider notifications (offer/assign alerts, connection state) | DONE |
| 11 | Remove extra test riders safely (backup first; keep Kei Bearer only) | DONE |
| 12 | 5A — COD reconciliation ledger | DONE |
| 13 | 5B — Rider route queue | DONE |
| 14 | 5C — Dispatcher operations board | DONE |
| 15 | 5D — Customer status message templates + notification log | DONE |
| 16 | 5E — Operating reports + CSV export | DONE |
| 17 | 5F — Emergency/contact-dispatch button | DONE |
| 18 | 5G — Delivery messaging (customer/rider/dispatcher) | DONE |

Each stage: implement, typecheck, run meaningful tests (new + full existing suite),
update this file with what was actually found/built/tested, update
`PHASE1_JOBS_CHECKPOINT.md`, then one commit. Continuing automatically between
stages per the user's instruction, unless a genuine blocker comes up (credentials,
an ambiguous product decision that can't be inferred safely, etc.) — those get
flagged here and in the checkpoint, not silently worked around.

## Stage 8 — Fix address entry (DONE)

**The bug** (in the pre-existing `apps/web/src/components/address-picker.tsx`,
found by reading it, not assumed): two call sites unconditionally overwrote the
typed input with provider text —
- `pickSuggestion(s)` set `query` to the picked suggestion's label, always.
- `movePin(point)`'s reverse-geocode callback set `query` to the reverse-geocoded
  label, always, every time the pin was dragged.

So typing "15-17 Half Way Tree Road..." and then picking a suggestion, or
nudging the pin afterwards, could silently replace "15-17" with whatever the
provider/reverse-geocode returned — exactly the failure mode described.

**The fix:**
- **Schema**: `apps/api/prisma/schema.prisma` — added nullable `addressProviderText`
  and `pickupAddressProviderText` columns to `Job` (the provider's formatted
  match, kept only for transparency — never authoritative). Backed up `dev.db`
  first (`data/dev.db.bak-preprod-20260910-165227`), pushed with
  `DEV_DB=1 npm run db:prepare` — clean, additive, no data loss.
- **Backend plumbing**: threaded the two new fields through `JobDto`
  (`packages/contracts/src/types.ts`), `jobToDto()`
  (`apps/api/src/modules/jobs/dto.ts`), and both `CreateJobBody`/`UpdateJobBody`
  zod schemas + their data-mapping in `apps/api/src/modules/jobs/create.ts`.
- **`AddressPicker` rewrite** (`apps/web/src/components/address-picker.tsx`):
  - `ConfirmedLocation` now separates `address` (what was typed — always
    authoritative) from `providerAddress` (informational only) and `point`.
  - Typed text (`query`/the input) is changed **only** by direct user typing.
    Nothing else — not `pickSuggestion`, not `movePin`'s reverse-geocode, not
    `useThisAddress` — ever calls `setQuery` except the one convenience case of
    filling an *empty* field from a picked suggestion.
  - Added an explicit "Use this address" action that geocodes the typed text
    for a point but leaves the text untouched; if the geocoder finds nothing
    (or errors), it falls back to a bias point / island-center point and shows
    a "could not verify automatically, position the pin manually" banner —
    the flow still completes, typed text intact either way.
  - The confirmation view shows the typed address as primary and the provider
    match (if present and different) as a secondary "Provider match:" line,
    alongside the pin's coordinates — both are visible together as required.
  - Wrapped the map in a small error boundary so a map/tiles failure degrades
    to a coordinates-only confirmation instead of blocking the flow.
- **`apps/web/src/pages/new-job.tsx`**: updated for the new `ConfirmedLocation`
  shape; the default pickup ("15-17 Half Way Tree Road, Kingston, Jamaica")
  keeps that exact text as `address` (not replaced by whatever the geocoder
  reformats it to) with the provider's match stored separately, and stays
  fully editable like any other address field. `addressProviderText` /
  `pickupAddressProviderText` are now sent through to `POST /jobs`.
  `zone-manager.tsx` needed no changes — it only threads `ConfirmedLocation`
  through, it doesn't construct one.

**Tests (new):**
- `apps/web/src/components/address-picker.test.tsx` (5 tests, jsdom + RTL,
  `PinMap`/`apiFetch` mocked) — covers: a "15-17 Half Way Tree Road" address is
  unchanged after picking a differently-formatted suggestion; unchanged after
  dragging the pin (reverse-geocode returns a different street, ignored); "Use
  this address" completes the flow with typed text intact when the provider
  finds no match at all; a suggestion never overwrites text once the user has
  typed something themselves; the confirmed view shows both the typed address
  and the pin coordinates together.
- `apps/api/test/jobs-address.test.ts` (3 tests, real Fastify app + isolated
  sqlite db) — covers: `POST /api/jobs` stores a "15-17 ..." address and a
  differently-formatted provider match as two separate fields, both exact; an
  apartment/unit + landmark-only address with no provider match is stored
  exactly with `addressProviderText: null` (not fabricated, not coerced to the
  typed text); a `PATCH` that changes only the point (simulating a pin drag)
  never touches the previously-stored `addressText`.

**Verification run:** `npm run typecheck --workspaces` clean (all real
workspaces — `e2e` has no typecheck script, pre-existing); `apps/web` vitest
8/8 passed; `apps/api` vitest 58/58 passed (55 pre-existing + 3 new); `npm run
build --workspace @ronmacrae/web` clean production build.

**Not done in this stage** (explicitly out of scope, tracked for later): the
public customer-facing `book.tsx` delivery-request form still uses a plain
text field for the destination with no map/geocoding at all — it has no
overwrite bug (nothing auto-fills it), so it wasn't touched, but it also has
no pin-confirmation step; if that's wanted, it's a separate feature request,
not a bug fix.

## Stage 9 — Rider availability toggle + configurable multi-job capacity (DONE)

**The bug** (found by reading the actual code paths, not assumed): a rider
accepting a job had their `Rider.status` silently flipped from `available` to
`on_job` (`transitionJob()` in `apps/api/src/modules/jobs/transition.ts`, on
the `to === "accepted"` transition). Broadcast eligibility
(`eligibleRiders()` in `apps/api/src/modules/offers.ts`) requires
`status === "available"` — so the moment a rider accepted their first job,
they silently stopped receiving any further offers, no matter how far under
their capacity they were. The rider dashboard's own toggle button then
compounded this by disabling itself entirely while `status === "on_job"`
(`apps/web/src/pages/rider-dashboard.tsx`), so a rider on a job couldn't even
manually mark themselves available/unavailable. A parallel bug: unassigning a
rider's last active job force-reset their status back to `available`
(`assign.ts`'s `unassignJob()`), silently overriding a rider's own
"unavailable" choice.

**The fix:**
- Removed both automatic status mutations (`transition.ts`'s accept-triggered
  `on_job`/`available` flip, and `assign.ts`'s unassign-triggered reset to
  `available`). Rider status is now changed **only** by the rider (or staff)
  explicitly, via the existing `PATCH /api/riders/:id/status` — job lifecycle
  events never touch it. This is the whole fix for "must not auto-switch off
  just because the rider accepted one job": since acceptance no longer moves
  status away from `available`, `eligibleRiders()`'s existing
  `status === "available"` check (unchanged) now correctly keeps a rider
  eligible for more offers indefinitely, as long as they're under capacity —
  no schema change needed, since the existing 4-value `RiderStatus` enum plus
  the existing `dailyCapacity` field (the max-concurrent-active-jobs limit;
  the field name predates this stage and is kept to avoid an unnecessary
  schema migration, but is now documented as such everywhere it's used) were
  already sufficient once the auto-mutation bug was removed.
- Rider dashboard (`rider-dashboard.tsx`): the "Available for jobs" /
  "Unavailable" toggle is now always clickable (no more disabling itself while
  on a job), toggles only between `available`/`unavailable` (never touches
  `offline`, and treats a legacy `on_job` value as "available" so old data
  displays sensibly), and a new capacity summary section shows
  "`N of dailyCapacity active jobs`" plus an "At capacity" warning once the
  rider has no more room for offers.
- `RidersService.setStatus()`: generalized the "can't go offline with active
  jobs" guard from checking `status === "on_job"` (which, per the fix above,
  will now rarely if ever be the current value) to checking the rider's actual
  active-job count directly, regardless of their current status label. Going
  `unavailable` is always allowed with active jobs (that's the point — stop
  new offers, keep finishing what you have); going fully `offline` is not.
- `RidersService`'s `CreateBody.dailyCapacity` default changed from 15 to 5,
  per the requirement ("default 5, overridable per rider"). Existing riders'
  already-set capacities are untouched — this only affects new riders created
  from here on.
- **Race-protection hardening**: since a rider can now legitimately hold
  several open offers at once (accepting one no longer removes them from
  future broadcasts), added a capacity re-check inside the offer-accept
  transaction itself (`POST /api/bearer/offers/:id/accept`), mirroring the
  check `assign.ts` already had for direct assignment. Two offers that were
  each valid at broadcast time (rider under capacity then) can no longer both
  be accepted if doing so would push the rider over their configured limit —
  the second accept is rejected with a 409 and the job is left unassigned
  rather than double-booking the rider.

**Tests (new, in `apps/api/test/offers.test.ts`):**
- A rider stays `status: "available"` through an offer accept, remains
  eligible for a fresh broadcast while under capacity, and is correctly
  excluded once truly at capacity.
- The accept-path capacity race: two broadcasts each see the rider as under
  capacity; accepting both is rejected on the second (409), leaving that job
  `new`/unassigned rather than over-committing the rider.
- Accepting a direct assignment and carrying it all the way to `delivered`
  never changes `rider.status` away from whatever it already was.
- A rider can set `unavailable` while carrying an active job, but not
  `offline`.

**Also fixed along the way (Stage 8 follow-up):** running the e2e suite
against Stage 8's rewritten `AddressPicker` surfaced two stale assertions in
`e2e/specs/booking.spec.ts` — the old placeholder text ("Start typing an
address…", now "Type the exact delivery address…") and an ambiguous
`getByText("Half Way Tree Road")` match that broke once the confirmed-address
view started showing both the exact typed address *and* the provider's match
as a secondary line (the Stage 8 fix working as intended, not a bug) — both
updated to match the new, more precise UI.

**Also found while re-verifying:** a long-lived manual preview server + TLS
proxy from earlier in this session (`node dist/main.js` / `node proxy.mjs`,
bound to port 3000 against the real `dev.db`) was still running and was being
silently reused by Playwright's `reuseExistingServer` setting instead of its
own isolated, freshly-seeded e2e server — causing spurious e2e failures
unrelated to any code change. Stopped both processes so e2e runs against its
own isolated `e2e-test.db` again; if manual real-device preview access is
still wanted, it needs restarting (see the production-readiness/manual-test
instructions from earlier in this file).

**Verification run:** `npm run typecheck --workspaces` clean; `apps/api`
vitest 62/62 (58 prior + 4 new this stage, across 2 new describe blocks in
`offers.test.ts`); full e2e suite
(`alerts`, `booking`, `gps-map`, `jobs`, `offers`, `push-optin`, `realtime`,
`rider-dashboard`, `smoke` — 17 tests) passes 17/17 serially; under higher
parallelism some specs intermittently fail due to the **already-documented,
not-yet-fixed** `RidersService.create()` hardcoding new riders to
`status: "available"` (see Stage 7's note in this file and the checkpoint) —
confirmed via isolated re-runs that every such failure this round was that
pre-existing cross-spec interference, not a Stage 9 regression.

**Not done in this stage** (explicitly out of scope, tracked for later): there
is still no admin/dispatcher UI page for creating or listing riders — capacity
(`dailyCapacity`) is configurable via the existing `PATCH /api/riders/:id` API
but has no settings-page form yet. Dispatcher-facing visibility of rider
availability/active-count/capacity (beyond the existing live map) is Stage 14
(5C — dispatcher operations board)'s job, not this one.

## Stage 10 — Diagnose and repair rider notifications (DONE)

**Diagnosis first** (actually traced the path, per the instruction, rather than
assuming it worked): read `apps/web/src/lib/realtime.tsx` (websocket client),
`apps/api/src/rt/hub.ts` (server hub), `alerts-toaster.tsx`, `layout.tsx`,
`job-offers-panel.tsx`, and `rider-dashboard.tsx`. Broadcast → toast → unread
badge already worked (confirmed by the pre-existing, still-passing
`alerts.spec.ts`/`realtime.spec.ts`/`offers.spec.ts`), and Stage 9 already fixed
the specific "rider stops receiving offers after accepting one job" defect. Four
real gaps remained, found by reading the code rather than assumed:

1. **No alert sound at all** — grepped the whole web app; zero audio code
   existed anywhere. Added `apps/web/src/lib/alert-sound.ts`: a short
   synthesized tone (Web Audio oscillator, no asset to ship, works offline),
   played from `alerts-toaster.tsx` alongside each toast. Wrapped in try/catch
   and an autoplay-blocked promise is silently swallowed — "where the browser
   permits" is handled by attempting and not erroring when blocked, not by
   trying to detect permission in advance.
2. **No connection-state indicator anywhere** — `realtime.tsx` tracked only a
   binary `connected` boolean, and nothing in the UI even read it. Replaced
   with a 3-state `status: "live" | "reconnecting" | "offline"` (offline
   specifically reflects the browser's own `navigator.onLine`/`online`/`offline`
   events — reconnect attempts never stop, but the label is honest about
   whether there's a network to reconnect over) and added a visible indicator
   (dot + label) in `layout.tsx`'s sidebar header, shown on every screen for
   every role (`data-testid="connection-status"`).
3. **Reconnects didn't re-fetch anything** — the socket reconnected fine, but
   nothing told any page to catch up afterward; a rider/dispatcher stayed
   showing stale data until their own poll interval (15-30s) happened to fire.
   Added `onReconnect(handler)` to the realtime context (fires on every `hello`,
   including the first), wired into `rider-dashboard.tsx` (offers + jobs),
   `job-offers-panel.tsx` (this job's offers), and `map.tsx` (rider locations).
4. **Offer expiry never updated a screen "immediately"** — expiry is lazily
   swept server-side only on the next offer-related read, so a screen sitting
   open past `expiresAt` kept showing "open" until its next poll. Since expiry
   is a pure function of `expiresAt` vs. the clock (no server round-trip
   needed to know it happened), added a 1-second client-side tick in both
   `OfferCard` (rider) and `JobOffersPanel` (dispatcher) that flips the
   displayed status to "expired" and disables Accept/Decline/Withdraw the
   instant the deadline passes, independent of any poll or push.

**Verified already-correct (no change needed, confirmed by reading + testing)**:
unavailable riders are excluded from broadcasts (`eligibleRiders()`'s
`status: "available"` filter, unchanged from Stage 9); direct assignment only
alerts the target rider (`assign.ts` sends only to `roomForRider`); accept/
decline/withdraw already push `job.state`/`job.assigned`/`offer` messages that
update all connected screens; the in-app alert path (websocket) is fully
independent of browser push (confirmed by reading — toasts/badge/sound all key
off `ws.onmessage`, never `Notification`/service-worker push events).

**Push credentials**: not missing in this dev/preview environment —
`apps/api/src/config.ts` already falls back to a well-known dev VAPID key pair
when `DEV_DB=1` and none are set, so opt-in browser push works today (confirmed
via the still-passing `push.test.ts` and `push-optin.spec.ts`). This is
unchanged from before this stage. Production still needs its own
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` set (already documented in that file) —
a standing production-readiness item, not a new gap found here. In-app realtime
(toast/badge/sound/card) does not depend on push either way.

**Tests (new)**: `e2e/specs/multi-job-notifications.spec.ts` — two real,
separately-logged-in rider browser sessions verifying, in one flow: a rider
already carrying one active job (dailyCapacity 2) receives a second,
unrelated broadcast live (card + "Job offers" heading + unread badge, no
reload) and can accept it up to exactly capacity, showing the "At capacity"
warning; a second rider who explicitly set themselves "unavailable" receives
nothing from the same broadcast; the connection-status indicator reads "Live".
Also fixed a pre-existing type error in `apps/api/test/offers.test.ts` (a
too-narrow response-shape cast from Stage 9 that vitest's esbuild transform
didn't catch but `tsc` did — `npm run typecheck --workspaces` is now run again
after every test-file edit, not just after source edits).

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 62/62; `apps/web` vitest 8/8; clean web build; full e2e suite (18 tests,
including the new spec) 18/18 both serially and at 3x parallelism (no
flakiness reproduced this round).

**Not done in this stage** (out of scope, tracked for later): no server-side
broadcast when an offer naturally expires (client-side clock-based detection
covers "immediate" without one, per above) — if a future stage wants the
underlying DB row itself flipped proactively rather than lazily, that's a
small addition (a periodic sweep + broadcast, same shape as
`LocationSimulator`'s existing interval pattern) but wasn't needed to satisfy
the actual requirement. WhatsApp/SMS delivery of these alerts is Stage 15 (5D).

## Stage 11 — Remove extra test riders safely (DONE)

**Inspected `dev.db` first** (never assumed): 115 `Rider` rows, of which
exactly one was real — Kei Bearer (`+8765550001`) — and the other 114 were
disposable e2e/manual-test riders (named things like "Assigned Rider", "GPS
Test Rider", "Map Test Rider", "Offer Test Rider", accumulated from earlier in
this session before/around when the API preview server was pointed directly
at `dev.db` for manual testing, rather than the isolated `e2e-test.db`
Playwright always uses). Confirmed `apps/api/src/seed.ts`'s `seedRider()` is
an `upsert` keyed on Kei Bearer's own phone — it was never the source of the
duplicates and is safe to re-run.

**Backup**: `apps/api/data/dev.db.bak-riders-20260910-173947` (timestamped,
gitignored, taken before any deletion).

**Schema-driven safety, not custom logic**: checked every `Rider`-owning
relation's `onDelete` behavior in `schema.prisma` before writing anything.
`Job.rider` is `onDelete: SetNull` — deleting a rider never deletes a job, it
only clears that job's `riderId` (order/job history survives even for a
long-gone test rider). Every other rider-owned table —
`JobOffer`/`RiderAssignment`/`RiderLocation`/`Route`/`ReconDaily`/`Payout`/
`SosAlert` — is `onDelete: Cascade`, so deleting the `Rider` row cleans those
up automatically, enforced by SQLite's own foreign keys (Prisma's SQLite
connector always runs with `PRAGMA foreign_keys = ON`). The one thing NOT
cascaded automatically: a rider's login (`User` row with `role: "rider"`,
linked via `Rider.userId`) — that relation points the other way, so it had to
be deleted explicitly per removed rider, which in turn cascades that user's
`Session` and `PushSubscription` rows.

**New script**: `apps/api/scripts/remove-test-riders.mjs` — dry-run by default
(prints exactly what would change, does nothing); `--yes` to actually execute;
refuses to run at all unless exactly one rider matches the kept phone number
(`--keep-phone`, default `+8765550001`); the whole deletion runs inside one
Prisma transaction; prints full before/after row counts and a post-check that
fails loudly if anything outside the expected scope changed.

**Result** (dry-run matched the real run exactly):

| Table | Before | After |
| --- | --- | --- |
| Rider | 115 | **1** (Kei Bearer only) |
| User | 119 | 5 (4 staff + Kei Bearer) |
| User (non-rider) | 4 | 4 — unchanged |
| Customer | 74 | 74 — unchanged |
| Zone | 3 | 3 — unchanged |
| Setting | 1 | 1 — unchanged |
| Job | 63 | 63 — unchanged (17 of them lost `riderId`, none deleted) |
| JobOffer | 625 | 3 (Kei Bearer's own) |
| RiderAssignment | 30 | 13 (Kei Bearer's own) |
| RiderLocation | 28 | 2 (Kei Bearer's own) |
| Session | 239 | 136 (removed riders' own sessions) |
| PushSubscription | 3 | 3 — unchanged (all 3 already belonged to Kei Bearer) |

Post-cleanup raw-SQL check confirmed **zero** orphaned rows anywhere (no
`JobOffer`/`RiderAssignment`/`RiderLocation` pointing at a deleted rider id, no
leftover `role: "rider"` `User` rows without a `Rider`, no `Job.riderId`
pointing at a rider that no longer exists).

**Live verification**: booted the API against the cleaned `dev.db`
(`DEV_DB=1`) and confirmed both Kei Bearer's rider login and the
dispatcher's staff login still work, `GET /api/riders` returns exactly
`["Kei Bearer"]`, and customers/zones are still fully intact and reachable.

**Test isolation reconfirmed** (already true from earlier stages, verified
again here rather than assumed): `e2e/playwright.config.ts` points
`DATABASE_URL` at its own `data/e2e-test.db`, entirely separate from
`dev.db` — this cleanup has zero effect on it, and e2e's own seed step only
ever creates/upserts riders in that isolated file, never `dev.db`. Full
`apps/api` vitest suite (62/62, uses its own per-file isolated sqlite dbs) and
two e2e specs re-run clean after the cleanup.

**Not done / explicitly out of scope**: did not delete any of the several
older `dev.db.bak-*` files already sitting in `apps/api/data/` from earlier
stages — they're harmless (gitignored, disk space only) and might still be
wanted as rollback points; only added this stage's own backup alongside them.

## Stage 12 — 5A: COD reconciliation ledger (DONE)

**What existed already**: `Job.amountExpected`/`amountCollected` and a
`POST /api/jobs/:id/collect` endpoint (`recordCollection()`, `payment.ts`) —
but that endpoint was never actually called from the frontend (grepped the
whole web app — zero references), so in practice there was no way to record a
COD collection at all before this stage, staff or rider. There's also an
existing `ReconDaily` model (per-rider, per-day aggregate with a `ReconStatus`
enum) — inspected it, decided it does not fit: this stage's spec wants a
per-job ledger with per-job fields (handover timestamp, rider notes) and the
exact status enum "Pending collection/Collected/Handed in/Disputed/Approved",
which doesn't map onto that daily aggregate. `ReconDaily` was left untouched.

**Schema** (backed up `dev.db` first as `dev.db.bak-cod-20260910-174615`,
clean additive push): added `codStatus`, `codCollectedAt`,
`codHandedInAmount`, `codHandoverAt`, `codRiderNote`, `codAccountantNote`,
`codApprovedById`/`codApprovedAt` directly on `Job` (reusing the existing
`amountExpected`/`amountCollected` rather than duplicating them), plus a new
append-only `CodEvent` model (jobId, from/to `CodStatus`, actor, note, meta,
at) for the audit trail — never edited or deleted, so even a later dispute
that reopens an approved entry leaves the original approval visible in the
trail.

**Backend** (`apps/api/src/modules/cod.ts`, new; `payment.ts`'s
`recordCollection()` extended):
- `POST /api/jobs/:id/collect` (existing endpoint, now wired to actually do
  something useful) — rider or admin/dispatcher (late reconciliation) records
  what was collected; on the first recording for a `cod` job this also flips
  `codStatus` to `collected` and stamps `codCollectedAt`. Also fixed a real
  permission gap found while extending it: it previously accepted ANY
  authenticated staff role (accountant, viewer) with no restriction at all —
  now restricted to rider (own job) or admin/dispatcher, matching the spec's
  role split.
- `POST /api/jobs/:id/cod/hand-in` — same permission rule; requires
  `collected` or later; records the handed-in amount + timestamp, moves to
  `handed_in`.
- `POST /api/jobs/:id/cod/approve` / `.../dispute` — admin/accountant only.
  Approve requires something already collected; dispute requires a non-empty
  note. Once `approved`, `collect`/`hand-in`/re-`approve` all return 409
  ("ask an accountant to dispute it first") — approved entries are locked
  against silent edits, though a deliberate accountant dispute can still
  reopen one (itself audited).
- `GET /api/cod` — dispatcher/accountant/admin/viewer board: every `cod` job,
  filterable by `codStatus`.
- `GET /api/jobs/:id/cod/events` — the audit trail for one job (rider can see
  their own job's; staff can see any).
- Shortage/overage (`codVarianceMinor` = handedIn − collected) is a computed
  DTO field, never stored, so it's always consistent with the two source
  amounts.
- Confirmed (and tested) the public customer tracking DTO
  (`TrackingPublicDto`, hand-built in `tracking.ts`, never reuses `jobToDto`)
  carries none of this — customers cannot see internal reconciliation by
  construction, not by a filter that could be forgotten later.

**Frontend**:
- `rider-dashboard.tsx`: a `CodPanel` on any `cod` job's card — status badge,
  expected/collected/handed-in shown as three distinct figures (never
  conflated with the "Delivery fee" or "Order value" fields already on the
  card, and rider earnings — a different figure entirely, shown on the offer
  card pre-acceptance — is never mixed in here), "Record collected"/"Record
  handed in" actions that disable once approved, a plain-language shortage/
  overage line, and the accountant's note if one exists.
- New page `apps/web/src/pages/cod.tsx` ("COD reconciliation", new `/cod`
  nav tab, staff-only): a filterable board of every COD job — status,
  expected/collected/handed-in/variance, an Approve/Dispute action pair
  visible only to admin/accountant (dispatcher/viewer see the same data
  read-only, matching "dispatcher/owner monitor; accountant/owner approve/
  dispute").

**Tests**:
- `apps/api/test/cod.test.ts` (10 new) — full collect→hand-in→approve
  lifecycle with variance calculation (shortage/exact/overage), every role's
  permission boundary (accountant/viewer can't record, rider can't approve/
  dispute, dispatcher can record on a rider's behalf, a rider can't touch
  another rider's job), approved-entries-are-locked (and the dispute-reopens-
  it exception), dispute requiring a note, and the audit trail's order.
  Includes a direct assertion that the public tracking response contains
  none of the `cod*` field names or rider note text at all.
- `e2e/specs/cod.spec.ts` (new) — real browser flow: rider records a
  collection and a short handover via the API, dispatcher views it on the
  board (monitor-only, no action buttons), signs out, accountant logs in,
  approves it from the UI, and the entry disappears from the "awaiting
  approval" filter and reappears correctly under "Approved" — plus a final
  API check that it's now locked.

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 72/72 (62 prior + 10 new); `apps/web` vitest 8/8; clean web build; full
e2e suite (19 tests, incl. the new spec) 19/19 serially.

**Not done in this stage** (explicitly out of scope, tracked for later): no
CSV export or reporting rollup of COD data yet — that's Stage 16 (5E,
operating reports). No dispatcher-board consolidation of "COD awaiting
handover" alongside rider load/location — that's Stage 14 (5C).

## Stage 13 — 5B: Rider route queue (DONE)

**What existed already**: `Job.routeSeq: Int?` was already in the schema and
already flowed through to `JobDto.routeSeq`, but nothing anywhere ever wrote
to it — no schema change needed for this stage at all. There's also a
separate, unrelated `Route`/`RouteStop` model pair plus a scaffolded (never
implemented, never called from the frontend) `POST /api/routes/optimize` —
inspected it and left it alone: that's clearly meant for a future real
route-optimization engine, which is explicitly NOT what this stage wants
("must NOT describe straight-line distance as driving distance/traffic-aware
ETA" — this stage is a simple, honest, rider-manual-reorder feature).

**Backend**: one new endpoint, `POST /api/bearer/jobs/reorder` (rider-only).
Takes the full ordered list of the rider's own active job ids and writes
`routeSeq` to match, in one transaction. Deliberately an all-or-nothing,
explicit action rather than a partial patch: the submitted id set must
exactly match the rider's current active jobs (same jobs, any order) or the
whole thing is rejected (409) — this is what "must NOT auto-rearrange the
queue without confirmation" turns into on the API side: there's no code path
that can reorder a queue except this one, rider-initiated call. Also expanded
`JobSummaryDto` with `point`/`pickupAddressText`/`pickupPoint`/`routeSeq` so
the dispatcher's read-only queue view (below) doesn't need a heavier per-job
fetch.

**Frontend**: new shared component `apps/web/src/components/route-queue.tsx`
(`RouteQueue`, `nextStopFor`, `mapsUrlFor`) used by both:
- The rider dashboard — a compact, ordered "Route queue" section above the
  full per-job detail cards (which are unchanged), with ↑/↓ buttons that
  post the full reordered list on each move (no drag-and-drop dependency;
  simpler and fully keyboard/accessible). Each row shows its *next* stop
  (pickup while not yet collected, destination after) with address, item
  summary, COD amount, requested date, an urgent badge/border, and an "Open
  in Maps" link that hands off to the device's own map app
  (`google.com/maps/dir/?api=1&destination=...`) — never our own map, never a
  distance/ETA number.
- A new read-only `RiderQueuePanel` on the dispatcher's Jobs screen — a
  "Route queue" button per assigned job's row (next to "Offers") expands the
  same rider's active-job queue in the same compact form, with no reorder
  controls at all (`onReorder` simply isn't passed).
- Default ordering (before a rider has ever manually reordered) is
  `routeSeq` (once set) → requested date → job-creation order (oldest
  first / FIFO) — deterministic on the client regardless of what order the
  API happens to return rows in, rather than silently depending on it.

**Tests**:
- `apps/api/test/route-queue.test.ts` (5 new) — reorder writes `routeSeq` to
  match the submitted order; rejects a submission that omits one of the
  rider's active jobs; rejects one that includes another rider's job (and
  confirms no partial write happened); a dispatcher cannot call the
  rider-only reorder endpoint; dispatchers can read a rider's active jobs via
  the existing `GET /api/jobs?riderId=` filter.
- `e2e/specs/route-queue.spec.ts` (new) — real browser flow: two jobs
  assigned to one rider, default FIFO order confirmed, rider moves the
  second stop up (one tap), confirms both the "Open in Maps" link and that a
  page reload shows the new order was actually persisted (not just local
  state), then signs out and a dispatcher logs in and views the same rider's
  queue with no reorder controls visible at all.

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 77/77 (72 prior + 5 new); `apps/web` vitest 8/8; clean web build; full
e2e suite (20 tests, incl. the new spec) 20/20 serially.

**Not done in this stage** (explicitly out of scope, tracked for later): no
drag-and-drop reordering (up/down buttons only — simpler, and fully
accessible without an extra dependency); no live realtime push when a queue
changes (dispatcher's read-only view polls every 20s, same as other list
views in this app) — reordering isn't as time-critical as an offer/
assignment, so this was a deliberate scope cut, not an oversight.

## Stage 14 — 5C: Dispatcher operations board (DONE)

**One new backend endpoint**, `GET /api/ops-board` (admin/dispatcher/
accountant/viewer), aggregates everything the spec asks for in one read-only
response so the frontend doesn't have to race five separate fetches:
- **Riders**: status, the rider's own "Available for jobs" toggle state,
  active-job count, configured capacity and remaining capacity, whether
  their websocket is *currently* connected to the realtime hub (new —
  exposes `RealtimeHub.clientForRider()`, which already existed
  server-side but was never surfaced to a client before), and their latest
  location.
- **Location honesty**: each rider's location carries `ageMs` and a `stale`
  flag (age > 5 minutes — riders report roughly every 15-30s while active,
  so 5 minutes of silence is a real warning, not a nitpick) computed
  server-side from the same `at`/`trackingState` data `map.tsx` already
  uses. A rider with no report at all gets `location: null` — **never** a
  fabricated/last-known point presented as current; the frontend renders
  "No report yet" for that case rather than inventing something to show.
- **Waiting offers**: every open, unexpired `JobOffer` system-wide (there
  was no such system-wide listing before — offers could only be viewed
  per-job or per-rider).
- **Urgent jobs**: active (non-terminal) jobs with `priority: urgent`.
- **Overdue jobs**: active jobs whose `promisedAt` (falling back to
  `scheduledAt`) has already passed, sorted most-overdue first.
- **COD awaiting handover**: jobs with `codStatus: handed_in` (built in
  Stage 12) — the accountant/owner queue that still needs approving.

This endpoint only aggregates existing data for display — it introduces no
new way to *change* anything, so it needed no new write-permission surface;
all four monitoring roles get read access, same as the underlying
riders/locations/jobs/cod endpoints it's built from.

**Frontend**: new `/ops` page (`OpsBoard`, new "Ops board" staff-only nav
tab) — a riders table (status/availability badge, active/capacity, a
connection dot, last-location age with a stale warning, Call/Message links
using the rider's own phone, and an inline "Route queue" toggle reusing the
same read-only queue view from Stage 13) plus four list sections (waiting
offers, urgent jobs, overdue jobs, COD awaiting handover). Extracted the
Stage-13 per-rider queue-fetching logic into a shared
`ReadOnlyRiderQueue` component in `route-queue.tsx` so the Jobs screen and
this new board use one implementation instead of two copies.

**Deliberately not built**: no in-place assign/broadcast controls on this
screen — those already live on the Jobs screen and this board links out to
it rather than duplicating them (the "quick actions" the spec asks for are
Call/Message/Route-queue directly on the board, plus a link to Jobs for
assign/broadcast, since jobs.tsx doesn't currently support deep-linking to a
specific job — that would be the natural next small improvement if wanted).

**Tests**:
- `apps/api/test/ops-board.test.ts` (7 new) — active-job-count/capacity math,
  a stale location correctly flagged, a fresh one correctly not, a rider
  with no location report ever getting `null` (never a fabricated point), a
  waiting offer listed and an expired one excluded, an overdue job flagged
  with a not-yet-due one excluded, a job awaiting handover listed and one
  merely "collected" excluded, and a rider role rejected outright (403).
- `e2e/specs/ops-board.spec.ts` (new) — real browser flow: a rider with one
  active job and no location report shows "1 / 2" and "No report yet"
  (never a fabricated position), a waiting offer and an overdue job both
  appear, and the inline route-queue toggle shows that job with no reorder
  controls (matching Stage 13's read-only guarantee).

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 91/91 (84 prior + 7 new); `apps/web` vitest 8/8; clean web build; full
e2e suite (21 tests, incl. the new spec) 21/21 serially, on a freshly-reseeded
`e2e-test.db`.

**Housekeeping note, not a Stage 14 defect**: mid-verification, the full e2e
suite briefly ran ~1.5 minutes (vs. its usual ~20-25s) with two unrelated
specs timing out, traced to `e2e-test.db` having accumulated a large number
of riders/jobs across many separate `npx playwright test` invocations this
session (the webServer's `reuseExistingServer` setting keeps reusing the same
db across runs; `npm run seed` only runs when that server first starts, not
on every invocation). Deleted `apps/api/data/e2e-test.db` and re-ran clean —
back to 21/21 in ~21s. Worth remembering for future sessions: if e2e specs
start running unusually slowly, delete that file (it's disposable and
gitignored) before assuming a real regression.

## Stage 15 — 5D: Customer status messages + notification log (DONE)

**What existed already** (a lot — read all of it before writing anything):
`packages/notifications` already had a full provider-agnostic outbox system —
`NotificationProvider` interface, a `MemoryProvider` (dev-safe, zero
credentials), a `TwilioProvider` (real WhatsApp/SMS via raw REST, no SDK),
11 templates with `{{param}}` rendering, and a queue-backed `NotifyService` +
`JobNotifier` already wired into several job-status transitions, plus an
existing `/notifications` page listing the outbox. This stage's real job
was diagnosing what was actually missing/wrong, not building from scratch —
and there were three genuine, concrete gaps:

1. **A real "never claim delivered without evidence" violation.**
   `TwilioProvider.send()` returned `status: "delivered"` the moment Twilio's
   API accepted the message — but accepting a message for sending is not the
   same as it reaching the recipient; real delivery confirmation only comes
   later via Twilio's own status-callback webhook, which this app never
   received. Fixed by:
   - Adding a genuine `sent` status (contracts `NotificationStatus` +
     `NotificationStatus` Prisma enum) between `sending` and `delivered` —
     "the provider accepted it," explicitly documented as not delivery
     confirmation.
   - `TwilioProvider.send()` now returns `"sent"`, never `"delivered"`, on a
     successful API call.
   - New `POST /api/notifications/twilio-status` (public — Twilio calls it
     unauthenticated, allowlisted in the global auth hook, HMAC-SHA1
     signature-verified whenever `TWILIO_AUTH_TOKEN` is configured) is the
     **only** thing that ever moves a message to a confirmed `delivered` or
     `failed`. Needed a small dependency-free
     `application/x-www-form-urlencoded` body parser registered in
     `server.ts` (Fastify only parses JSON by default) since that's the
     content-type Twilio's callback actually sends. `MemoryProvider` is
     untouched — it's an explicitly-labeled dev fake, not a real external
     system making a false claim, so its instant "delivered" simulation is
     honest within its own documented scope.
2. **Two of the spec's 8 lifecycle events were never triggered at all.**
   "Order created" had a template (`order_confirmed`) but nothing ever
   enqueued it; "heading to pickup" had no template or trigger at all.
   Fixed: `JobNotifier.forOrderCreated()` fires from
   `history.ts`'s `createTrackingLinkInner()`, but only the very first time a
   job gets a tracking link (a later refresh isn't a new order, so it's
   never repeated) — this is also the natural point where the tracking URL
   actually exists to include. `JobNotifier.forRiderStage()` fires a new
   `heading_to_pickup` template from `recordRiderStage()` when that specific
   stage is reported (not `at_pickup`/others, which aren't customer-facing
   events per the spec's own list).
3. **"In transit" and "near destination" were the same message.** Both the
   `in_transit` and `delivering` job statuses enqueued the identical
   `out_for_delivery` template — "on the way" and "arriving now" are
   different, useful signals to a customer waiting for a delivery, not one
   repeated. Split `delivering` onto its own new `near_destination` template.

**Configurable templates** (the spec's other explicit ask): added a
`notificationTemplates` `Setting` row (admin-only `PUT
/api/notifications/templates`, merges into the existing override map rather
than replacing it wholesale — verified with a dedicated test, since an
earlier draft of this endpoint would have silently wiped out every other
template's saved override on each save) holding text overrides; every
template still has its hard-coded default, so the system is fully usable
untouched. `renderTemplate`/`listTemplates` in `packages/notifications`
take the effective (override-or-default) body; `NotifyService.dispatch()`
resolves the current overrides on every send.

**A real silent-notification-failure default, found and fixed.** New
customers created via the staff booking flow (`POST /customers`) defaulted
`consentTracking` to `false` — meaning the *ordinary* staff-booking path (not
the public self-service form, which already defaulted it `true`) would
silently send **zero** customer notifications ever, for every normal order,
regardless of anything else in this stage. Flipped that default to `true`
(delivery-status tracking is not marketing — `consentMarketing` stays a
separate, still-opt-in flag — and matches the public form's own existing
default), fully documented inline and still per-customer toggleable for
someone who asks not to be messaged.

**Frontend** (`notifications.tsx`, rewritten): friendly status labels
(Pending/Sent/Delivered/Failed/Skipped, mapped from the underlying
queued/sending/sent/delivered/failed/suppressed enum) with each failed
message's error shown and a Retry button (admin/dispatcher); an explicit
"Preview mode" banner when the active provider is `memory`, stating plainly
that nothing is really sent and documenting the exact steps to connect a
real provider later (env vars + the Twilio status-callback URL — no
credentials/billing touched by this stage); a "Message templates" panel
showing all templates with their effective text, editable by admin only,
read-only (with an explicit "only an owner/admin can edit" note) for
everyone else who can see the page.

**Tests**:
- `packages/notifications/test/index.test.ts` — fixed the one pre-existing
  assertion that encoded the old, wrong "delivered" claim; now expects
  `"sent"`.
- `apps/api/test/notifications.test.ts` (14 new) — new customers default to
  `consentTracking: true`; order-confirmed fires once on the first tracking
  link and never again on a refresh; it's skipped entirely without consent;
  heading-to-pickup fires on that stage and not on `at_pickup`; in_transit
  and delivering produce genuinely different template names; templates
  list/edit endpoints (unknown name rejected, admin-only write, an override
  persists and reports `overridden: true`, and — the bug this test caught —
  saving one template never wipes out another's already-saved override);
  the Twilio webhook moves `sent → delivered`/`failed` correctly, is a safe
  no-op for an unknown message id, and is reachable unauthenticated.
- `e2e/specs/notifications.spec.ts` (new) — a real staff-booked order shows
  up in the outbox with the `order_confirmed` template and a friendly status
  label; a dispatcher sees the templates panel read-only while an admin can
  edit it.

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 98/98 (84 prior + 14 new); `packages/notifications` vitest 6/6;
`apps/web` vitest 8/8; clean web build; full e2e suite (23 tests, incl. 2 new)
23/23 serially, on a freshly-reseeded `e2e-test.db`.

**Not done in this stage, explicitly** (per the instruction): no real
WhatsApp/SMS provider was purchased, activated, or connected — `memory`
remains the active provider; the Twilio path is fully built and tested with
synthetic requests but stays dormant until real credentials are supplied
later, exactly as documented in `twilio.ts`'s own activation-steps comment.

## Stage 16 — 5E: Operating reports + CSV export (DONE)

**Reused an existing scaffold rather than duplicating it**: `contracts/
routes.ts` already had a `reports: { summary, csv }` entry pointing at
`/api/reports/summary` and `/api/reports/jobs.csv` — pre-planned, never
implemented anywhere (checked before writing anything). Built this stage's
backend to those exact paths instead of inventing new ones.

**Backend** (`apps/api/src/modules/reports.ts`, new; admin/accountant only,
matching the spec's own stated audience): a single `buildReport()` computes
everything from one `Job` query plus its `customer`/`rider`/`zone`
relations —
- **Three mutually-exclusive buckets** (every job falls into exactly one):
  `completed` (delivered), `failed_cancelled` (failed/cancelled/returned),
  `active` (everything else, including `new`/unassigned). The bucket counts
  are always computed over the date/rider/zone/payment-method filters but
  *not* narrowed by the bucket filter itself, so picking one bucket to
  inspect never changes what the other two counts mean.
- **COD math**: expected/collected/handed-in summed directly; outstanding
  summed only from jobs where expected still exceeds collected; shortage/
  overage summed from the same handed-in-vs-collected variance Stage 12
  already computes per job, never estimated.
- **Average delivery time**: `completedAt - createdAt`, only for jobs
  actually `delivered` with a real `completedAt` — never a scheduled or
  promised timestamp standing in for an actual one, per the spec's explicit
  instruction. The sample size riding along with it (`averageDeliveryTimeSampleSize`)
  means a single delivery's "average" can never be silently mistaken for a
  stable figure.
- **Rider earnings are explicitly an estimate** (`payRate x jobsCompleted`)
  — there's no real payout-history feature in this app yet (the `Payout`/
  `PayoutLine` models are unused scaffolding, checked before assuming
  otherwise) — and a rider with no configured `payRate` gets `null`, never
  `$0`, with a call-out in `notes` so a genuine zero can never be confused
  with missing data.
- **Off-currency jobs** (a job whose currency differs from the operational
  one) are excluded from every money total but still listed in the rows/CSV,
  with a note explaining why the totals don't include them — rather than
  either silently mixing currencies into one number or silently dropping
  the job from view.
- **Filters**: `from`/`to` (on `createdAt`), `riderId`, `zoneId`, `bucket`,
  `paymentMethod` — all combinable.
- **CSV export** (`GET /api/reports/jobs.csv`) — job-level rows, no delivery
  PIN and no customer phone number at all (only the customer's name, needed
  to reconcile a specific delivery); every export is audit-logged (who, when,
  which filters).

**Frontend**: new `/reports` page (admin/accountant-only nav tab, matching
the backend's own gating, plus a role-guarded fallback screen for anyone who
navigates there directly) — filter controls, a `notes` warning banner shown
above everything else when the data is incomplete in some way, summary
cards for every metric the spec lists, a by-rider table showing "rate not
set" (not "$0") where appropriate, and an "Export CSV" link using the exact
same filters currently applied.

**Tests**:
- `apps/api/test/reports.test.ts` (10 new) — bucket counts and fee/urgent
  totals; the full COD math (expected/collected/handed-in/outstanding/
  shortage/overage) across a deliberately mixed set of jobs; average
  delivery time computed only from real `completedAt` values (a job with
  only a `promisedAt` contributes nothing) and reported as `null`/sample
  size 0 when nothing's delivered yet; rider earnings computed correctly
  when a rate exists and `null` with a note when it doesn't; the bucket and
  payment-method filters; role gating (admin/accountant allowed, dispatcher/
  viewer/rider rejected); the CSV export's headers and its explicit absence
  of a job's PIN or the customer's phone number.
- `e2e/specs/reports.spec.ts` (new) — an accountant filters the report to
  one rider, sees "1" completed job and "rate not set" plus the
  no-configured-pay-rate note, and confirms the CSV export link carries the
  same filter; a dispatcher gets no "Reports" nav link at all and a
  friendly not-authorized message if they navigate there directly.

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 108/108 (98 prior + 10 new); `apps/web` vitest 8/8; clean web build;
full e2e suite (25 tests, incl. 2 new) 25/25 serially, on a freshly-reseeded
`e2e-test.db`.

**Not done in this stage** (explicitly out of scope, tracked for later): no
zone/city breakdown table (the zone *filter* works and narrows every number
above; a dedicated "totals by zone" table wasn't built, since the spec's
filter list and metric list don't actually require one together — worth
adding if wanted). No real payout-run feature — "estimated earnings" stays
exactly that until a real payout/payroll feature exists.

## Stage 17 — 5F: Emergency/contact-dispatch button (DONE)

**What existed already**: `BusinessSettings.dispatchPhone`/`dispatchWhatsApp`
(owner-configurable via the existing admin-only `PUT /api/settings/business`,
built in an earlier stage) — this stage just needed to *surface* that
configured number to the rider, since the rider had no way to fetch it at
all: `GET /api/settings/business` is staff-only (admin/dispatcher/
accountant/viewer), and riders aren't any of those roles.

**Backend**: one new endpoint, `GET /api/bearer/dispatch-contact`
(rider-only), returning a deliberately narrow `DispatchContactDto`
(`businessName`/`dispatchPhone`/`dispatchWhatsApp` only) rather than opening
up the full `BusinessSettings` object to riders (which also carries
currency/PIN-length/zone config that's none of a rider's concern) — and,
per the spec's own wording, this is *only* ever the owner-configured
dispatch contact, never any individual staff member's own phone number
(there is no code path here that could expose one).

**Frontend**: new shared `ContactDispatch` component, rendered on every
active job card on the rider dashboard (gated to `ACTIVE_JOB_STATUSES`,
matching "every active rider job" — not shown on completed/failed ones).
Call and Message links use the device's own `tel:`/`sms:` handlers; a
WhatsApp link (`wa.me`) appears only if `dispatchWhatsApp` is configured.
The job reference is included in the prefilled SMS/WhatsApp message text
(a phone call can't carry text, so the label next to the buttons names the
job instead: "Contact dispatch about RM-000123"). If no dispatch number is
configured at all yet, shows a plain "not configured yet" note instead of a
dead link.

**Tests**:
- `apps/api/test/dispatch-contact.test.ts` (2 new) — returns exactly the
  configured phone/WhatsApp/business name and nothing else from
  `BusinessSettings`; rejected for a staff token (rider-only).
- `e2e/specs/contact-dispatch.spec.ts` (new) — a real rider session shows
  the Call link pointing at the exact configured `tel:` number, the Message
  link's `sms:` href decodes to include the job's own reference, and no
  WhatsApp button appears when `dispatchWhatsApp` was left blank.

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 110/110 (108 prior + 2 new); `apps/web` vitest 8/8; clean web build;
full e2e suite (26 tests, incl. 1 new) 26/26 serially, on a
freshly-reseeded `e2e-test.db`.

**Not done in this stage** (small, deliberate scope cuts): no equivalent
button was added for staff-side "contact rider" — that already exists from
Stage 14's operations board (Call/Message per rider row, using the rider's
own phone, which staff are already authorized to see). No feature-detection
of which contact methods a specific device supports beyond what `tel:`/
`sms:`/`wa.me` links already defer to the OS — a desktop browser with no
phone/SMS handler configured will simply do nothing on click, which is the
inherent, correct behavior of that link type rather than something to work
around.

## Stage 18 — 5G: Delivery messaging (DONE) — last of the numbered stages

**What existed already**: per-job `TrackingLink` tokens (customer-facing,
no login), the realtime hub (`RealtimeHub`, room-per-job/rider/dispatch
broadcast), and `JobEvent` as the existing audit trail for job-lifecycle
changes. Nothing for in-app chat, and nothing modeling an address-change
request as a reviewable, auditable action distinct from just editing
`Job.addressText` directly.

**Schema** (additive only; backed up `dev.db` first as
`dev.db.bak-messaging-20260910-190823`, verified Job=63/Rider=1 unchanged
and both new tables at 0 rows after `db:prepare`):
- `DeliveryMessage` — one row per chat message, `senderRole` (customer/
  rider/dispatcher/system), optional `senderId`/`senderName`, `body`, and
  three independent read flags (`readByCustomer`/`readByRider`/
  `readByStaff`) so each side's unread state is tracked separately.
- `AddressChangeRequest` — `requestedByRole`, `proposedAddressText`,
  `status` (pending/approved/declined), `reviewedById`/`reviewedAt`. The
  official `Job.addressText` is **never** touched by creating this row —
  only an explicit staff approve action updates it, inside one transaction
  with the new `JobEvent` audit entry.

**Backend** (`apps/api/src/modules/delivery-messages.ts`, new): three
parallel route groups sharing the same list/send/address-change logic —
- Customer (public, via the tracking link token — no login): `GET`/`POST
  /api/tracking/:token/messages`, `POST /api/tracking/:token/address-change`.
  A revoked link is 410 for everything; an expired-but-not-revoked link
  still allows reads (`open:false`) but returns 409 on writes — matching
  the same "history stays visible, but you can't act on a dead link" rule
  used for the tracking page itself.
- Staff (`GET`/`POST /api/jobs/:id/messages`, plus
  `GET /api/jobs/:id/address-change-requests` and per-request
  `.../approve` / `.../decline`): read is admin/dispatcher/accountant/
  viewer, write (send + approve/decline) is admin/dispatcher only.
  Approve writes `Job.addressText` + a `JobEvent` + a confirming system
  message, all inside one transaction; both approve/decline 409 if the
  request isn't still `pending` (no double-review).
- Rider (`GET`/`POST /api/bearer/jobs/:id/messages`,
  `POST /api/bearer/jobs/:id/address-change`): 403 if the job isn't
  assigned to that rider — checked on every request, not just the first.

Shared safeguards: max message length 1000 chars (400 if exceeded); a
sender-role rate limit of 15 messages per job per 60s (429 if exceeded);
`open` is derived from the job's actual status
(`!TERMINAL_JOB_STATUSES.includes(job.status)`) for staff/rider, and from
`linkOpen && jobOpen` for the customer — history is always readable
regardless, only sending closes. No phone numbers, PINs, or internal notes
are ever included in a `DeliveryMessageDto`. A new `delivery_message`
realtime event nudges staff/rider UIs to refetch immediately rather than
waiting for their poll interval; the customer tracking page has no
websocket, so it polls only.

**Frontend**: one shared `DeliveryChat` component
(`apps/web/src/components/delivery-chat.tsx`) used by all three roles —
message list (right-aligned bubbles for the viewer's own messages, muted
italic for system messages), quick-reply buttons, a send form, and an
optional "Request address change" form — hidden behind a read-only note
when the conversation is closed or the viewer is monitor-only. Wired in:
- `track.tsx` (customer) — quick replies "I'm here" / "Please call me" /
  "I need to change the landmark" / "I'm unavailable"; the address-change
  form posts to the customer endpoint and shows "Waiting for dispatch to
  confirm" until reviewed.
- `rider-dashboard.tsx` (rider) — new `RiderJobChat`, inside a collapsible
  "Messages" `<details>` on each job card; quick replies "Heading to you" /
  "I've arrived" / "I cannot reach you" / "Please contact dispatch"; nudged
  live via `useRealtime().subscribe(["delivery_message"], …)`.
- `jobs.tsx` (dispatcher) — new `DispatcherJobChat`, behind a "Messages"
  toggle on every job row (mirroring the existing Route-queue pattern),
  showing any pending address-change request with "Confirm change"/
  "Decline" buttons above the chat itself; confirming re-fetches both the
  request list and the chat so the resulting system message appears
  immediately without a manual refresh.

**Tests**:
- `apps/api/test/delivery-messages.test.ts` (12 new) — customer↔dispatcher
  exchange with correct `senderName`/`isSelf`; rider 403'd out of another
  rider's job (both read and write); accountant/viewer read-only (403 on
  write); conversation closes on terminal job status for staff and rider
  (409 write, `open:false` read); customer conversation closes on an
  expired-but-not-revoked link (200 read / 409 write) and is fully 410 on a
  revoked one; an address-change request does **not** touch
  `Job.addressText` until approved, then does (asserted via raw Prisma
  query, plus the `JobEvent` and system message); a declined request never
  touches the address and can't be re-reviewed (409 on a second decision);
  rider can also propose an address change; message length >1000 chars
  rejected (400); a send burst eventually 429s; response JSON never
  contains the job's PIN, the customer's phone, or the substring "phone".
- `e2e/specs/delivery-messages.spec.ts` (new) — one end-to-end pass across
  all three roles on a single job: customer sends a message and proposes
  an address change from the public tracking page; dispatcher sees both,
  confirms the address change (asserted against the API afterward that
  `addressText` actually changed), and replies; rider (after signing out
  of the dispatcher session first — `/login` redirects an
  already-authenticated user instead of showing the form, so a real
  sign-out is required between role switches in one test) sees the reply
  and sends a quick reply; the customer's still-open tracking tab picks up
  the rider's reply via its poll, with no page reload.

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 122/122 (110 prior + 12 new); `apps/web` vitest 8/8; clean web
build; full e2e suite, fresh `e2e-test.db`, 27/27 real specs passing
serially (28th failure is the pre-existing stray `zz-debug.spec.ts` debug
script, already flagged separately for removal — not part of this stage
and not a regression).

**Not done in this stage** (deliberate scope cuts, matching the spec's own
"text-only initially" and "abuse protection... reasonable... limits"
wording): no attachments/images; no per-viewer typing indicators; no
admin-configurable rate-limit threshold (hardcoded at 15/60s); no separate
"block this customer" abuse tool beyond the existing rate limit — a
repeat-offender workflow would need a product decision on what "blocked"
means for a walk-up/phone customer with no account, which is out of scope
here. Offline/reconnecting state reuses the existing `useRealtime` status
already surfaced elsewhere in the rider/dispatcher UI (Stage 10); the
customer tracking page has no realtime channel at all (by design — no
login, so no per-customer socket to authenticate), so for the customer
"offline" is simply "the last poll failed", shown via the existing
`conversation.error` message in `DeliveryChat`.

This was the last of the numbered stages (8–18, covering items 1–5A–5G of
the original request). Next: the closing instruction — renumber the
existing Verification section and build out the expanded verification
checklist across all of Stages 8–18. See the new
"## Verification checklist (Stages 8–18)" section below.

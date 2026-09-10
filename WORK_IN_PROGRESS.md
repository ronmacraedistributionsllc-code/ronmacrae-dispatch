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

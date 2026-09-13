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

## Verified gates §1 — Stages 1–5, offers/GPS/alerts (historical; superseded by "Verification checklist (Stages 8–18)" at the end of this file)

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

## Verified gates §2 — Stage 7, address-first ordering/zones/alerts/db isolation (historical; superseded by "Verification checklist (Stages 8–18)" at the end of this file)

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

## Verification checklist (Stages 8–18) — the renumbered, authoritative Verification section

This replaces the two historical "Verified gates §1/§2" sections above and
`PHASE1_JOBS_CHECKPOINT.md`'s "Verification §0" as the current, complete
checklist — it is the numbered list the original request's closing
instruction asked for, mapping each required behavior to the specific
test file(s)/case(s) that actually verify it (all passing as of the
Stage 18 commit `8a6ed48`; api = `apps/api/test/`, web =
`apps/web/src/components/`, e2e = `e2e/specs/`).

1. **Typed address is authoritative, never silently overwritten** (item 1,
   Stage 8). `web/address-picker.test.tsx`: "keeps an exact typed address
   ('15-17 ...') unchanged when a suggestion is picked", "keeps the typed
   address unchanged after dragging the pin", "lets 'Use this address'
   confirm exact typed text even when the provider finds no match", "does
   not overwrite already-typed text with a suggestion label when the field
   wasn't empty". `api/jobs-address.test.ts`: stores an exact address plus
   the provider's differing match without altering either; a PATCH
   updating only the point never touches the previously-typed `addressText`.

2. **Rider availability/multi-job capacity is rider-controlled, not
   auto-toggled** (item 2, Stage 9). `api/offers.test.ts`: "excludes a
   rider already at daily capacity from both broadcast and rebroadcast";
   "keeps status 'available' through accept, and remains eligible for a
   fresh broadcast while under capacity"; "rejects an accept that would
   push the rider over capacity"; "accepting an assignment and completing
   it never changes rider.status away from what the rider set"; "a rider
   can go 'unavailable' while still carrying an active job, but not fully
   'offline'". `e2e/multi-job-notifications.spec.ts`: a rider carrying a
   job still gets new offers live, an unavailable rider gets none.

3. **Rider notifications actually reach the rider (toast/badge/sound,
   connection state, reconnect)** (item 3, Stage 10). `e2e/realtime.spec.ts`:
   a rider's open dashboard shows a new offer live without a reload;
   a dispatcher's offers panel updates live on accept. `e2e/alerts.spec.ts`:
   direct assignment alerts and bumps unread only for the assigned rider.
   `api/push.test.ts`: subscribe/unsubscribe round-trips genuinely to the
   API, scoped per-user. Connection state (`live`/`reconnecting`/`offline`)
   and `onReconnect` are exercised implicitly by every e2e spec's realtime
   assertions above running against a real WS connection, not a mock.

4. **Extra test riders removed safely, only Kei Bearer remains** (item 4,
   Stage 11). One-time data operation, not an automated test: verified at
   the time via a timestamped backup (`dev.db.bak-riders-20260910-173947`)
   plus before/after row-count and identity checks documented in this
   file's Stage 11 section — the rider list is exercised by every
   subsequent stage's tests (offers, route-queue, ops-board, cod, etc.),
   all of which assume and confirm exactly one active rider, Kei Bearer.

5. **COD calculations and permissions** (5A, Stage 12). `api/cod.test.ts`:
   full collect→hand-in→approve lifecycle with auto-calculated shortage/
   overage; zero-variance and overage cases; an accountant cannot record a
   collection/hand-in; a dispatcher can record on a rider's behalf; a
   rider cannot record another rider's job; a viewer can monitor but not
   approve/dispute; a rider cannot approve/dispute their own entry.

6. **COD approval/dispute audit history** (5A, Stage 12).
   `api/cod.test.ts`: "blocks a further collect or hand-in once approved,
   but allows a deliberate accountant dispute afterward"; "dispute requires
   a non-empty note" — both assert against the underlying `CodEvent` audit
   trail, not just the summary status.

7. **Multi-job route queue with ordering that actually persists** (5B,
   Stage 13). `api/route-queue.test.ts`: sets `routeSeq` to match the
   submitted order for exactly the rider's active jobs; rejects a reorder
   omitting one of the rider's jobs or including another rider's job; a
   dispatcher cannot reorder a rider's queue (read-only view only).
   `e2e/route-queue.spec.ts`: a rider reorders their queue, a dispatcher
   views it read-only, and neither reorders on its own.

8. **Urgent/overdue indicators + dispatcher rider-load/stale-location
   display** (5C, Stage 14). `api/ops-board.test.ts`: reports a rider's
   active-job count and remaining capacity; marks a stale location
   honestly and never fabricates a position when there's no report at
   all; flags an overdue job (`promisedAt` in the past, still active) and
   excludes one not yet due; lists a waiting offer (never an expired one)
   and a job awaiting COD approval; not reachable by a rider role.
   `e2e/ops-board.spec.ts`: the same board, rendered.

9. **Customer-message isolation, rider access limited to assigned
   conversations, and messaging closure timing** (5G, Stage 18).
   `api/delivery-messages.test.ts`: "a rider sees only the conversation for
   their own assigned job, never another rider's"; "an accountant/viewer
   can monitor (read) but not respond (write)"; "closes to new messages
   once the job reaches a terminal status, for both staff and rider";
   "closes to the customer once the tracking link has expired (read-only
   history remains)"; "a revoked tracking link blocks the conversation
   entirely (410), not just writes".

10. **Address-change approval flow** (5G, Stage 18).
    `api/delivery-messages.test.ts`: "a customer's proposed address is not
    applied until dispatch explicitly approves it"; "a declined request
    never touches the job's address, and cannot be reviewed twice"; "a
    rider can also propose an address change, subject to the same review".
    `e2e/delivery-messages.spec.ts` confirms the same flow end-to-end,
    including the actual API-level `addressText` change after "Confirm
    change" is clicked.

11. **Notification templates + provider fallback** (5D, Stage 15).
    `api/notifications.test.ts`: order-confirmed fires once and respects
    consent; heading-to-pickup/in-transit/near-destination use genuinely
    distinct templates; only an admin can write template overrides, an
    unknown template name is rejected, an override persists and is
    reflected back, and — the bug caught this stage — "saving one
    template's override never wipes out another's already-saved one"; the
    Twilio status webhook moves `sent`→`delivered`/`failed` and is
    harmless on an unknown message id (the provider-fallback path: Twilio
    accepting ≠ delivered until the webhook confirms it).

12. **Reports, filters, and CSV totals** (5E, Stage 16).
    `api/reports.test.ts`: buckets delivered/active/failed-cancelled
    correctly and sums fees + urgent count; computes expected/collected/
    handed-in/outstanding/shortage/overage across mixed jobs; average
    delivery time from actual (not scheduled) timestamps, `null` (not
    zero) when nothing delivered in range; rider earnings computed from
    `payRate × completed jobs`, or an honest `null` + note when no rate is
    configured; the bucket filter narrows rows and counts consistently;
    filters by payment method; permissions (admin/accountant only); CSV
    export has a job-level header row and — cross-checked against item
    13 below — no PIN or phone columns.

13. **Emergency/contact-dispatch Call/Message links** (5F, Stage 17).
    `api/dispatch-contact.test.ts`: returns the owner-configured dispatch
    phone/WhatsApp and never a staff member's own phone; rider-only
    (staff get 403). `e2e/contact-dispatch.spec.ts`: a rider's Call link
    points at the exact configured `tel:` number, the Message link's
    `sms:` href includes the job's own reference, and no WhatsApp button
    renders when unconfigured.

14. **No PIN/phone/unnecessary-data leakage, checked directly, not just
    assumed** (cross-cutting across items 1–5). `api/cod.test.ts`: "the
    public tracking DTO has no COD ledger fields at all".
    `api/reports.test.ts`: CSV export has no PIN or phone columns.
    `api/dispatch-contact.test.ts`: never a staff member's own phone.
    `api/delivery-messages.test.ts`: "message DTOs never carry a phone
    number or the delivery PIN" (asserted against the raw serialized JSON,
    not just the typed DTO shape). The public tracking DTO itself
    (`TrackingPublicDto`) intentionally exposes the delivery PIN to the
    *customer* it belongs to (needed for the rider to confirm handoff) —
    that is the one deliberate exception, and it is scoped to that one
    customer's own delivery via their own tracking token, never to staff
    listings, CSV exports, or any other customer/rider's view.

**How to re-run this whole checklist**: `npm run typecheck --workspaces`,
`npm run test --workspace @ronmacrae/api` (122 tests), `npm run test
--workspace @ronmacrae/web` (8 tests), and, from `e2e/` with a fresh
`e2e-test.db`, `npx playwright test --workers=1` (27 real specs; ignore
`zz-debug.spec.ts`, flagged separately for removal).

---

# Second mega-request — delivery experience, customer identity, messaging
# and cancelled-order management (Claude Code, 2026-09-11)

This refines the existing marketplace scope (preserve business model + all
completed Stage 8–18 features). Ten numbered requirement sections; the user's
own closing instruction is the same as before: bounded stages, checkpoint +
`WORK_IN_PROGRESS.md` after each, commit only after verification.

## Two findings that changed how the rest of this plan is scoped

Surfaced while starting Stage 19 — recorded here since they shaped
everything from Stage 20 on, not just as a footnote:

1. **No multi-business data model existed at the time.** The schema was
   single-tenant: one `Setting`-backed `BusinessSettings` singleton, one
   `Customer` table, one `Rider` table, no `Business` model at all — flagged
   to the user before going further, since several later sections' own
   wording presupposes a multi-business "network" (section 4: "across
   participating businesses"; section 6: "business-specific customer
   relationships"; section 9: "Business → Riders → cash held for **my**
   business"). **Resolved**: the user asked for real multi-tenancy, built
   now as Stage 20 (below) — a `Business` model, global User/Rider identity
   with per-business memberships, and business isolation verified across
   orders/offers/messages/GPS/cash-ledgers/reports/realtime. Everything from
   Stage 21 on is now written business-aware from the start.
2. **The Stage 18 delivery-messaging model is one shared thread per job**,
   not the three distinct pairwise conversations this request's section 5
   describes (customer↔dispatch, customer↔rider, rider↔dispatch). Today,
   customer/rider/dispatcher all read and write the same `DeliveryMessage`
   rows for a job — which is exactly the "accidentally create a group chat"
   failure mode section 5 explicitly warns against. Fixing this properly
   needs a real thread-scoping change (a `conversationKind` dimension, or
   separate models), not just additive read-receipts/retry work. **Deferred
   to the dedicated Stage 24 (section 5) rather than patched hastily now.**

## Stage plan

| # | Stage | Section(s) | Status |
| - | ----- | ---------- | ------ |
| 19 | Three-step rider flow + rider dashboard (Offers / To pick up / In my possession / History) | 1, 2 | DONE |
| 20 | Multi-tenancy foundation: Business model, global User/Rider identity with per-business/platform memberships, isolation across orders/offers/messages/GPS/cash-ledgers/reports/realtime, verified with two businesses sharing one rider | (foundational — enables 4, 6, 7, 9) | DONE |
| 21 | UI/UX refresh pass (typography, contrast, empty/loading/error states, mobile bottom nav) across rider/customer/dispatcher screens + verified screenshots | 3 | DONE |
| 22 | Customer package dashboard + restricted rider-location display post-collection, across participating businesses | 4 | DONE |
| 23 | Global customer identity: phone normalization (libphonenumber, JM default), safe email normalization, verified-vs-provisional records, duplicate-resolution audit trail, rate limiting, per-business customer relationships on top of Stage 20's Business model | 6 | DONE |
| 24 | Messaging redesign: split the one shared thread into the three real pairwise conversations, add delivered/read receipts, retry-without-duplicate, reassignment access revocation | 5 | DONE |
| 25 | Sign-in/account linking: email verification, password reset, account-claim flow, expiring/single-use codes; Instagram login feasibility investigation (implement only if genuinely supported for this use case; otherwise document why it's disabled) | 7 | DONE |
| 26 | Deleted-orders trash: soft-delete + 30-day restore window + scheduled purge job, preserving ledger/dispute/audit records, scoped per business | 8 | DONE |
| 27 | Rider cash-profile corrections: separate collected / awaiting handover / handed-in-unconfirmed / confirmed / disputed / earnings-payable, snapshot money components, fix "handed in" prematurely clearing confirmed-owed amount, per business a rider works for | 9 | DONE |
| 28 | Full verification + handoff pass across all of 19–27 | 10 | DONE |
| 29 | New follow-up request (separate from the original ten sections): simplify the rider job workflow to one accept step, auto cash defaults, dispatch cash approval, promoted Customer Unavailable, Available Jobs, messaging clarity + 24h rider-customer grace window, delivery date/time defaults, address-search accuracy | (new request, 8 points) | DONE |

Each stage: implement, typecheck, run meaningful tests (new + full existing
suite), update this file with what was actually found/built/tested, update
`PHASE1_JOBS_CHECKPOINT.md`, then one commit — same discipline as Stages
8–18. Isolated test data only; real dev accounts/orders (Kei Bearer, the
seeded staff logins, the current `dev.db`) are left untouched.

## Stage 19 — Sections 1+2: three-step rider flow + rider dashboard (DONE)

**What existed already**: the `JobStatus` state machine already separates
acceptance (`assigned → accepted`) from collection (`accepted → picked_up`)
— the schema needed **no migration** for this. The gap was entirely at the
rider-facing UI layer: the old dashboard exposed 4–6 buttons per job status
(`Heading to Pickup`, `Arrived at Pickup`, `Collected`, `Not Answering`,
`Customer Changed Location`, `Failed`, all as equal-weight buttons opening
one generic form), and the job list was one flat, unsectioned feed mixing
active and completed jobs together.

**A real backend bug found and fixed**: `transitionJob`'s DB write used
`tx.job.update({ where: { id: jobId }, ... })` — keyed only by id, with no
guard against the job's status having already moved on since the read at
the top of the function. Two concurrent requests for the same transition
(a double-tap before a button visually disables, or a retried offline
action) could **both** pass the state-machine check and both write —
double `JobEvent`, double cash-collection application, double customer
notification. Fixed by switching to a guarded `tx.job.updateMany({ where:
{ id: jobId, status: from }, ... })` + count check inside the same
transaction: the loser gets a clean 409, not a silent double-apply. Applied
the same guard to `recordRiderStage` (rider sub-progress reports), plus a
fast no-op path when the reported stage hasn't actually changed.

**Backend**: `apps/api/src/modules/jobs/transition.ts` — the guard above;
no schema or route changes.

**Frontend** (`apps/web/src/pages/rider-dashboard.tsx`, rewritten):
- `primaryActionFor(job)` / `secondaryActionsFor(job)` replace the old flat
  `actionsFor` — every job status now has exactly one primary next step
  (Accept → Confirm collection → Start delivery → Mark delivered) and the
  exception paths (Not Answering / Customer Changed Location / Failed)
  are tucked behind an explicit "Other options" disclosure, never shown as
  equal-weight buttons.
- New `ActionSheet` component — a dismissible bottom sheet (mobile) /
  centered modal (desktop) for every action, primary and secondary alike.
  Shows business name, job reference, item summary and destination; the
  collection step explicitly asks the rider to confirm it's the right
  package; the delivered step keeps the existing PIN requirement. Entered
  note/PIN/address text lives in the parent card's state, not the sheet
  itself, so dismissing (backdrop click, Escape, or Cancel) and reopening
  never loses what was typed.
- Dashboard restructured into counted sections: **Offers**, **To pick up**
  (`assigned`/`accepted`), **In my possession** (`picked_up`/`in_transit`/
  `delivering`/`location_changed`/`no_answer`/`failed` — the rider still
  physically holds the package in all of these), and a collapsed
  **Completed history** (`delivered`/`cancelled`/`returned`) — previously
  all jobs rendered in one undifferentiated list regardless of status.
- Card fields aligned to the spec list: business name, job reference,
  product/quantity/size/colour, pickup + destination, urgent badge, "Cash
  to collect" clearly separated from "Your delivery fee" (COD amount was
  previously labeled ambiguously as just "COD amount"), a Navigate button
  (opens the destination in the device's own maps app via a universal
  Google Maps deep link), and the existing Message-customer (chat) /
  Message-business (`ContactDispatch`) actions made into visible buttons
  rather than a single collapsed "Messages" disclosure.
- **Removed the customer's raw phone number from the rider card entirely**
  (it showed `name · phone` before) — replaced with just the customer's
  name. This matches the project's own existing "no phone-number exposure,
  in-app only" rule (established in Stage 18) that the old card violated.
- The old `heading_to_pickup`/`at_pickup` rider-stage buttons were removed
  from the primary/secondary action set (they're not part of the 3-step
  flow the spec asks for) — the backend endpoint (`POST
  /api/bearer/jobs/:id/stage`) is untouched and still callable (e.g. by a
  future richer client), so nothing that previously recorded that
  sub-progress is broken, it's just no longer surfaced as rider buttons.

**Tests**:
- `apps/api/test/jobs-transition.test.ts` (new, 4 tests): the full
  accepted→picked_up→in_transit→delivered path with PIN enforcement and a
  full JobEvent audit trail; skipping a step and moving another rider's
  job are both rejected; **the duplicate-submit race** — two concurrent
  identical transition requests — asserted to produce exactly one 200 +
  one 409 and exactly one JobEvent, not two; a repeated identical
  rider-stage report is a no-op, not a second audit event.
- `e2e/specs/rider-dashboard.spec.ts` (rewritten for the new UI): the full
  accept → confirm-collection → start-delivery flow through the actual
  bottom-sheet UI, a live duplicate-submit race fired at the API while the
  UI is mid-flow, and a check that a delivered job moves out of the active
  card list into the collapsed completed-history section.
- `e2e/specs/delivery-messages.spec.ts` updated for the renamed
  "Message customer" button (was a "Messages" disclosure summary).

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 126/126 (122 prior + 4 new); `apps/web` vitest 8/8 + clean build;
full e2e suite, fresh `e2e-test.db`, 27/27 passing serially.

Three other specs needed a small update, not because anything they cover
regressed, but because the dashboard's own behavior deliberately changed:
`offers.spec.ts`, `multi-job-notifications.spec.ts` and `realtime.spec.ts`
all asserted the old "Job offers" section heading disappears when there
are no offers — the new dashboard shows all three sections (Offers / To
pick up / In my possession) permanently, with a count badge, rather than
appearing/disappearing (matching the spec's "three clearly separated
sections with counts" wording). Updated each to assert on the actual
signal they cared about instead (the empty-state copy, the specific offer
card, or the count) rather than the heading's visibility. Also fixed a
locator that matched both an offer card and the now-accepted job's card
(same item-summary text) — scoped to the "Decline" button instead, which
only an open offer renders.

**Not done in this stage**: dashboard visual/typography refresh (Stage 21);
customer/dispatcher screen changes (Stage 21/22); the rider-earnings figure
still uses the existing `job.fee` field as a stand-in for "your delivery
fee" — Stage 27 (section 9) is where money components get properly
snapshotted per order to avoid any double-counting against the COD total.

## Stage 20 — Multi-tenancy foundation (DONE)

The user's explicit answer to Stage 19's open question: **"build real
multi-tenancy now."** Preserve Ronmacrae as the first business and migrate
its existing data without resetting it; one global identity per person with
business-specific staff memberships; riders get a global profile with
memberships in multiple businesses; the user is the platform owner, business
admins manage only their own businesses, and platform approval gates a
rider working the open network. First priority (per the user's own
ordering): implement and verify business isolation across orders, offers,
messages, GPS, cash ledgers, reports and realtime subscriptions, tested with
two businesses sharing one rider — before continuing the rider-interface/
identity/messaging/cash-profile work already queued.

**Migration** (backed up `dev.db` first as
`dev.db.bak-multitenancy-20260910-235645`; three-phase — schema pushed with
every new `businessId` nullable, a data-backfill script, then the columns
tightened to required, each phase verified by row-count diffs before the
next):
- New models: `Business` (settings that used to live in the old
  `Setting("business")` singleton now live directly on it, per business),
  `StaffMembership` (a User's role at one specific business — a User is now
  the global identity; role lives on the membership, not the user),
  `RiderMembership` (a Rider's relationship with one specific business:
  pending/active/suspended/removed), plus `PlatformRole` (owner) on `User`
  and `PlatformRiderStatus` (pending/approved/suspended) on `Rider` — the
  platform-wide gate on a rider working the open network at all, separate
  from any one business's own membership decision.
- `businessId` added to Job/Customer/Zone/JobOffer (required); `Customer`'s
  phone-unique constraint and `Zone`'s slug-unique constraint both became
  per-business composites (`@@unique([businessId, phone/slug])`) — the same
  phone number is now a separate Customer row at a different business, not
  a collision. `Job.jobNumber`/`externalRef` uniqueness likewise became
  per-business (each business's own RM-000001 sequence).
- `apps/api/scripts/backfill-multitenancy.mjs` (new, dry-run by default,
  `--yes` to execute, one transaction, idempotency-guarded against a second
  run): created the "Ronmacrae Distributions" Business from the old
  settings blob; backfilled `businessId` onto all 65 jobs / 76 customers /
  3 zones / 17 offers; created a StaffMembership for each of the 5 existing
  staff users mirroring their prior role exactly (nothing about their
  access changed); created an active RiderMembership for Kei Bearer, marked
  platform-approved (a real, already-vetted rider, not a new signup);
  created a dedicated platform-owner login (`owner@ronmacrae.example`),
  deliberately separate from any business's own admin — the owner oversees
  every business but isn't automatically a member of any one of them.
  Verified: every Job/Customer/Zone/JobOffer row has a non-null businessId
  post-migration, all prior row counts unchanged.

**Auth/session redesign**: the JWT payload gains `businessId` (the business
a staff session is scoped to — absent for riders and for a platform-owner
session) and `platformRole`. Login resolves the actor's `StaffMembership`
list and picks one (explicit `businessId` in the request, or the first
active one — no business-switcher UI yet, a documented gap for a multi-
business admin); a rider or platform-owner gets no fixed session business.
`Session` gained a `businessId` column so a refresh carries the *same*
business forward rather than re-resolving to "first membership" every time,
which would otherwise let a multi-business admin's session silently jump
business mid-session. `guards.ts`'s `requireStaff` now also requires
`businessId` to be present (not just the role match) — closing a real gap
where a platform-owner token could otherwise pass a role check and then hit
a business-scoped list route with `businessId: undefined`, which Prisma
treats as "no filter" rather than "no business" (a one-line guard standing
between that and a real cross-tenant leak). A new `requireOwner` guard
exists for future platform-owner-only routes (none added yet — owner
console UI is out of this stage's bounded scope).

**Isolation enforced across all seven named areas** — every list/read/write
route for these now filters or asserts on `businessId` (404, not 403, on a
cross-business access attempt, so a business never even learns another
business's resource exists):
- **Orders**: `jobs/repository.ts`'s list filter, and a shared
  `assertJobBusiness` guard (`jobs/dto.ts`) applied at every job-mutating
  function (transition, assign/unassign, collect, cancel/return, tracking
  links, history) — skipped only for the rider path, which is checked by
  riderId ownership instead (a rider legitimately spans businesses).
- **Offers**: `eligibleRiders()` now requires an *active RiderMembership at
  the broadcasting business*, not just globally `active`/`available` — the
  actual mechanism a shared rider only receives the right business's
  offers. Offer list/withdraw scoped; the accept flow re-checks the
  rider's membership is still active at accept time (it could have been
  suspended between broadcast and accept).
- **Messages**: every staff route (`delivery-messages.ts`) checks the
  job's businessId before reading/writing; customer/rider paths already
  scoped by token/riderId ownership, untouched.
- **GPS**: `GET /api/rider-locations` and the ops board's rider roster/
  location both scope to riders with an *active membership* at the
  requesting business (matching the roster a business can see/plan
  against) — a rider never a member of a business (or removed from it)
  never appears on that business's map or ops board, on any business,
  regardless of who else they're currently delivering for. (An earlier,
  stricter draft of this rule — "only while on an active job for THIS
  business right now" — broke the legitimate "see my available riders
  before assigning anything" use case an existing e2e spec already
  verified; reverted to the membership-based rule, which still fully
  prevents a business from seeing a rider they've never worked with.)
- **Cash ledgers (COD)**: `GET /api/cod`, per-job COD event history, and
  hand-in/approve/dispute all scoped/asserted on businessId.
- **Reports**: `buildReport()` takes a required `businessId` and filters
  every job query by it — the summary, CSV export and every total are
  scoped.
- **Realtime**: the single global `"dispatch"` room is gone — replaced
  with `roomForDispatch(businessId)` everywhere a job/offer/message/
  notification/rider-status/rider-location event broadcasts to staff
  (17 call sites across jobs/offers/delivery-messages/notify/riders/
  location-sim). `hub.ts`'s `mayJoin` now checks business ownership before
  letting staff explicitly join a `job:`/`customer:`/`dispatch:` room —
  previously any authenticated staff member could join *any* job/customer
  room by just asking, which was harmless in a single-tenant system and a
  real leak in a multi-tenant one.
- Also fixed along the way (not one of the 7 named areas, but directly
  required for correct isolation): `ZonesService`/`FareEngine` (zone
  detection and fee quoting are now business-scoped — an unscoped version
  could have quoted using another business's zone), the "Contact dispatch"
  endpoint (a rider now passes which job's business they mean, since they
  can carry jobs for several at once), and `CustomersService` (business-
  scoped, matching the new per-business phone-uniqueness).

**Test harness**: rather than editing the ~90 existing test-fixture call
sites across a dozen files, `test/helpers/test-app.ts` now creates one
default `Business` per test file and wraps its Prisma client in a `$extends`
query interceptor that fills in that business's id on `job`/`customer`/
`zone`/`jobOffer.create()` calls that omit it, and auto-adds an active
`RiderMembership` there whenever a test creates a `rider`. This is
test-fixture-only — real request-handling code always sets `businessId`
explicitly from the authenticated actor, so the default never fires for
anything actually going through the API. TypeScript still required
`businessId` in each fixture's own literal (the extension changes runtime
behavior, not the generated Prisma types), so ~90 call sites across 10
files were still mechanically updated to satisfy the compiler; `tokenFor`
gained an optional `businessId`/`platformRole` override, defaulting staff
tokens to the harness's own business.

**A real bug found while wiring this up**: a brand-new rider added by a
business (`POST /api/riders` with a never-before-seen phone) was landing
with membership `pending` — correct in spirit (platform approval gates a
rider joining the *open network*) but wrong for the everyday case: the
business creating the rider is *already* vouching for them directly, and
the old single-tenant behavior always made a newly-added rider immediately
usable. Fixed: the creating business's own membership goes `active`
immediately; `platformStatus` still starts `pending` and only gates a
*second*, different business later adding the *same* (already-existing)
rider to share them. Caught by 10 e2e specs failing (offers, ops-board,
route-queue, reports, realtime) before the fix — all passing after it.

**`seed.ts` rewritten** to create the Business first and thread its id
through every staff/rider/zone/customer upsert (StaffMembership per staff
user, an active platform-approved RiderMembership for Kei Bearer) — the
e2e suite reseeds a disposable `e2e-test.db` from scratch on every run, so
this had to become multi-tenancy-aware from the ground up, not migrated.

**Tests**: `apps/api/test/multi-tenancy.test.ts` (new, 7 tests) — two
businesses, one rider with an active membership at both, covering all
seven areas: orders (list/get/cancel all 404 across businesses), offers
(the shared rider is eligible at both, an A-only rider never is at B's
broadcast), messages (read/write both 404 cross-business, the intruding
message never lands), cash ledgers (COD list/events/hand-in all excluded
cross-business), reports (summary + CSV both scoped), GPS (a business
never sees a rider it's never worked with; gains and keeps visibility once
an actual membership exists), and **realtime** — a genuine live `ws`
connection test (the harness's Fastify app listening on an ephemeral port,
two real WebSocket clients) proving a `job.state` broadcast for Business
A's job reaches only A's socket, and that B's socket can't even join A's
job room by guessing its id.

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 133/133 (126 prior + 7 new multi-tenancy tests); `apps/web` vitest
8/8 + clean build; full e2e suite, fresh `e2e-test.db`, 27/27 real specs
passing serially — every pre-existing spec still green, not just the new
isolation test.

**Also restarted** (as this stage's schema/build changes made their old,
already-running processes incompatible with new writes): the LAN and
Cloudflare-tunnel demo servers from earlier this session, on the freshly
built multi-tenancy-aware `dist` — both verified working (login, a real
write) afterward. Worth flagging honestly: the LAN demo (port 3000/8443)
was actually killed as a side effect of this stage's own `lsof -ti:3000 |
xargs kill` e2e-prep step run several times during this work — not a
deliberate stop. It's back up now; sorry for the gap if you were using it.

**Not done in this stage** (explicitly out of bounded scope, queued for
later stages or flagged as open gaps): no owner-console UI (business
creation/listing, rider platform-approval screen) — the backend guard
(`requireOwner`) and data model exist, no routes/screens use them yet; no
business-switcher UI for a staff member with multiple memberships (defaults
to their first, or an explicit `businessId` at login); `FareRule` (zone-pair
fare overrides) and notification-template overrides remain global/unscoped
— documented in-code as a deliberate simplification, not a leak (fare rules
resolve through already-scoped zone ids; template *wording* isn't sensitive
data); rider `dailyCapacity`/earnings figures remain global-not-per-business
by design (a rider's real total load has to be visible to anyone
considering assigning them more work). Sections 4/6/7/9's actual feature
work (customer package dashboard, global customer identity, sign-in, cash-
profile corrections) starts next, now on top of this foundation.

## Stage 21 — Section 3: modern, usable interface (DONE)

Bounded to real, verifiable gaps against the spec's own checklist, rather
than a ground-up redesign — much of the surface was already solid from
earlier stages (Stage 19's rider dashboard: sectioned cards, empty states,
dismissible bottom sheets that preserve entered data; the customer tracking
page: single-column, already mobile-native; status badges throughout
already pair color with a text label, never color alone).

**Mobile bottom navigation** (`components/layout.tsx`, rewritten) — the
one checklist item that was flatly absent. The desktop/tablet sidebar is
unchanged; on mobile it's replaced by a fixed bottom nav (icon + label,
`env(safe-area-inset-bottom)`-aware) showing the first 4 of the role's own
filtered tab list, with a "More" button opening a dismissible sheet for
the rest. **A real, pre-existing bug found in the process**: the sidebar's
user-info/Sign-out block was `hidden md:block` — on mobile, signing out
was completely unreachable through the UI at all. Fixed: Sign out now
lives in the "More" sheet, so it's always reachable on every screen size.
**A second bug found**: the tab list's `STAFF_ONLY_TABS` filter forgot
`/zones` — a rider's nav showed "Zones & Fares", a staff config screen
with nothing for them to do there. Fixed (confirmed visually — see
Verification below — a rider's nav now shows only Dashboard and
Notifications).

**Ops board mobile responsiveness** (`pages/ops-board.tsx`) — the rider
roster was a 6-column table, unusable on a phone (forced sideways
scrolling, tiny tap targets). Desktop/tablet keeps the table unchanged;
mobile gets a parallel stacked-card layout (`RiderCard`, new) with the
same data and larger, icon-labeled action buttons — both render in the
DOM simultaneously, toggled by Tailwind's responsive `hidden`/`md:block`
classes, so a viewport resize needs no reload. Distinct `data-testid`s
(`ops-rider-card-*` vs the desktop's existing `ops-rider-row-*`) so the
two never collide in the DOM at once. Also added a "Try again" retry
button to the board's error state, which previously just showed a static
red line with no way to recover short of a full page reload.

**A real bug found while wiring the mobile nav** (unrelated to it, but
surfaced by re-touching the same file): `useBusinessName()` on the rider
dashboard called the (Stage 20-updated) dispatch-contact endpoint without
the `jobId` it now requires — a real TypeScript compile error that should
have been caught by Stage 20's own typecheck run and wasn't. Fixed by
threading the job's id through, which is also the *more correct* fix in
the multi-tenancy sense (the business name shown is always that specific
job's own business, not whichever business happened to answer first).

**A second real bug found, this one load-bearing for the whole e2e suite**:
a full serial run started intermittently failing its very last two tests
(`smoke.spec.ts`) with a page that rendered raw JSON —
`{"error":{"message":"Rate limit exceeded, try again in [object
Object]"...}}`. Root cause: the global `@fastify/rate-limit` ceiling
(1000 req/min) is keyed per-IP, and in e2e every test's traffic — now 29
specs, all polling, all logging in and out — shares one IP (localhost),
unlike real production traffic spread across many users. Fixed properly,
not just band-aided: `RATE_LIMIT_MAX` is now a config value (`config.ts`),
defaulting to the same 1000/min in production; `e2e/playwright.config.ts`
overrides it much higher for the e2e webServer only. Also fixed the
error message itself while in there — it was interpolating the whole
context object (`"try again in [object Object]"`) instead of
`context.after`.

**Verification — real, not just automated**: beyond the full test suite,
used the Browser tool against the live Cloudflare-tunnel demo (still
running from earlier this session) to actually look at the rendered
screens at both mobile (375×812) and desktop widths — logged in as
dispatcher and as the rider, and opened a live customer tracking link.
Confirmed by eye: the mobile bottom nav renders with the right active-tab
highlight and icons; tapping "More" opens the sheet with the remaining
tabs and a working, dismissible-by-Escape Sign out that actually signs
out; the ops board swaps cleanly from table to cards at mobile width with
identical data and larger tap targets; the rider's nav now shows only
Dashboard/Notifications (the `/zones` fix, confirmed live, not just by
reading the code); the customer tracking page renders as a clean
single-column mobile view with the live map, status badge, and history.
Static screenshot files aren't separately exportable from this session's
browser tooling, so this verification was done by direct visual
inspection in the moment rather than attached images — the same live
demo links already shared with the user let them see the identical views
themselves, on any device, immediately.

**Tests**: `e2e/specs/mobile-nav.spec.ts` (new, 2 tests) — the mobile
bottom nav shows the right primary tabs and the desktop sidebar nav is
hidden at that width; "More" reaches every overflow tab plus Sign out,
is dismissible by backdrop tap without navigating away, and actually
signs out when used; the ops board table becomes stacked cards with the
same data at mobile width.

**Verification run**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 133/133 (unchanged — this stage touched no API business logic,
only the rate-limit config plumbing); `apps/web` vitest 8/8 + clean
build; full e2e suite, fresh `e2e-test.db`, 29/29 (27 prior + 2 new)
passing serially — including confirming the rate-limit fix by
reproducing the failure once, then re-running clean after the fix.

**Not done in this stage** (deliberate scope cuts, not overlooked): the
main dispatcher Jobs screen's table (8 columns, many nested action/chat/
queue panels per row) was deliberately *not* converted to a mobile-card
layout in this pass — it already has a horizontal-scroll wrapper (usable,
not broken, just not optimal), but a full responsive redesign of the
platform's most complex, most heavily e2e-tested screen is a larger,
standalone piece of work better done on its own rather than folded into
this bounded stage; it already has an `overflow-x-auto` wrapper so it's
usable, not broken, on a phone. No icon-library rollout — the existing
emoji-as-icon convention (established in Stage 18/19: "📍 Navigate", "💬
Message customer") was extended into the new nav rather than introducing
a dependency for this stage. Typography/spacing scale, dedicated
reconnecting-state UI beyond the existing connection-status dot+label,
and a full contrast audit (beyond spot-checks made while touching these
specific files) are not separately itemized — no further gaps were found
against the checklist in the screens touched.

## Stage 22 — Section 4: customer package dashboard + restricted
rider-location display (DONE)

A phone-verified, cross-business "my packages" dashboard — a customer who
has ordered from more than one business on the platform sees all of it in
one place, without an account or password. Deliberately built as a real,
bounded feature on top of Stage 20's multi-tenancy foundation rather than
waiting on Stage 23's full customer-identity system: it uses a small,
explicitly provisional phone normalizer (`lib/phone.ts`'s
`normalizePhoneJM`, Jamaica-default, exact-match only) instead of the
proper libphonenumber-based one Stage 23 will bring in, and it groups
packages by phone match, never merging or deduping customer identities —
that judgment call is exactly what Stage 23 is for. A normalization miss
just means a package doesn't show up (a safe failure), never a wrong
match.

**Access model**: no login. A customer enters their phone number at
`/my-packages` (also linked from the header of the existing per-job
tracking page); the API sends a 6-digit, 10-minute, single-use code over
the existing notification outbox (`customer_dashboard_code` template);
entering it correctly returns a short-lived (24h) signed token — a
distinct JWT `type` (`customer_dashboard`, see `lib/jwt.ts`'s new
`CustomerDashboardTokenPayload`), never the staff/rider `access` type, so
it is structurally impossible for it to slip past `requireStaff`/
`requireRider` no matter what a guard forgets to check. A cooldown (30s
between requests) and an attempt cap (5 tries per code) bound abuse; the
global per-IP rate limiter (Stage 21) still applies underneath both.

**Two real bugs found and fixed while building this** (both are
consequences of the exact isolation problem Stage 20 set out to close,
just in a corner Stage 20's own verification pass didn't reach):

- **`GET /api/notifications` had no business filter at all.** Any staff
  member at any business could list — and `POST .../retry` could resend —
  *every* business's outbound customer notifications: full message text,
  phone numbers, and tracking-link tokens included. Found because this
  stage's own OTP code rides the same outbox and had to not leak the same
  way. Fixed properly: `OutboxMessage` gained a nullable `businessId`
  (derived from the linked job at enqueue time; nullable because a
  platform-level message like this one's own OTP code has no single owning
  business), backfilled onto the 22 existing rows via
  `scripts/backfill-outbox-business.mjs` (dry-run by default, same
  convention as Stage 20's migration script), and `list()`/`retry()` now
  require and enforce it — `retry()` 404s on a businessId mismatch or a
  null-businessId row, same "a business must never learn a foreign
  resource exists" rule used everywhere else in this codebase. A dedicated
  test now asserts the dashboard's own OTP message is invisible to every
  business's notification list, on top of the isolation fix itself.
- **The single-job tracking page showed a rider's live location
  unconditionally** once `job.riderId` was set and any location row
  existed — before pickup, and forever after delivery/cancellation/return,
  regardless of the job's actual status. This endpoint had no direct test
  coverage before this stage (only indirect coverage via delivery-messages
  and the gps-map e2e spec, neither of which exercised this path). Fixed:
  location is now shown only while the job is actively out with the rider
  (`picked_up`/`in_transit`/`delivering` — the same restriction the PIN
  already had, now named `LOCATION_VISIBLE_STATUSES` and exported from
  tracking.ts so the new dashboard applies the identical rule rather than
  a second, possibly-drifting copy). `apps/api/test/tracking.test.ts` (new
  — this file didn't exist before) covers all four states: before pickup,
  actively out, delivered, and cancelled.

**What the dashboard shows**: active (not yet delivered/failed/returned/
cancelled) vs. history, split like the rider dashboard's own offers/
in-progress/completed convention. Each card: business name, item summary,
customer-facing status, amount, courier name, the PIN (only while en
route, same rule as the single-job page), and — only when
`LOCATION_VISIBLE_STATUSES` allows it — a "live location available"
indicator linking through to the full single-job tracking page (which has
the actual map) rather than embedding N inline mini-maps per card, a
deliberate scope cut to keep this bounded. That link only ever points at
an *already-existing*, unexpired, unrevoked tracking link — this public
route never creates one itself, since creating tracking links stays a
staff-only action everywhere else in the system.

**Tests**: `apps/api/test/customer-dashboard.test.ts` (new) — wrong-code
handling without consuming a correct one, the resend cooldown, a consumed
code failing on reuse, the OTP message's invisibility to staff, a 401 on
a missing/invalid session token, and the real cross-business scenario:
one phone with an active job at Business A, a *delivered* job at Business
A with a rider and a fresh location row on file (asserting no location
leaks through despite that), and a picked-up job at Business B (asserting
its location and PIN *do* show) — genuinely exercising two businesses
sharing data through nothing but a matching phone number, the same spirit
as Stage 20's own two-businesses-one-rider test. `apps/api/test/
tracking.test.ts` (new) covers the single-job restriction directly.
`e2e/specs/my-packages.spec.ts` (new, 3 specs) covers the real-browser
request-code flow, an invalid-phone inline error, and the tracking-page
link-through — deliberately stopping short of completing verification in
the browser, since the 6-digit code is delivered by SMS (the memory
provider just logs it in dev/e2e) and — by design — is never exposed to
any staff view or API response, so there is no legitimate way for a
black-box browser test (or a real visitor without their phone) to read
it. The full request → verify → dashboard round trip is instead covered
at the API-integration level, which has real Prisma access to read the
code the way a delivered SMS would have carried it.

**Verification**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 143/143 (133 prior + 10 new); `apps/web` vitest 8/8 + clean build;
full e2e suite, fresh `e2e-test.db`, 32/32 (29 prior + 3 new). `dev.db`
backed up before the schema change (`data/dev.db.bak-*`); the additive
schema push and the outbox-businessId backfill were both verified against
the real `dev.db` with before/after row counts (all 76 customers, 66
jobs, and 22 outbox messages preserved; 0 orphaned rows in the backfill).

**Not done in this stage** (deliberately deferred to Stage 23, section 6):
real phone normalization (libphonenumber), verified-vs-provisional
records, a duplicate-resolution audit trail, and any actual merging of
customer identities across businesses — this stage only groups by an
exact, provisional phone match. Also not done: embedding a live map per
card on the dashboard itself (link-through only, see above), and any
account/persistence beyond the 24h session token — that's Stage 25
(sign-in/account linking), a deliberately separate, heavier flow (email
verification, password reset, account claim) this stage doesn't attempt
to front-run.

## Infrastructure fix — e2e no longer shares a port with either live demo

Small, standalone fix, done before starting Stage 23: `e2e/playwright.config.ts`
moved its webServer from port 3000 to a dedicated 3900. Port 3000 was
always shared with the LAN demo's own API server (behind the local HTTPS
proxy on 8443) — every "reset the port before a clean e2e run" step
(`lsof -ti:3000 | xargs kill`) was a live risk to whatever was actually
running there, and it genuinely killed the LAN demo more than once across
Stages 20-22 (each time caught and the demo restarted, but avoidable).
The Cloudflare-tunnel demo's own API server (port 3001) was never
collided with, but 3900 is clear of both, plus Vite's own dev-server
default (5173) and the LAN proxy (8443) — nothing else in this repo uses
it. No other file hardcoded port 3000 for e2e purposes (checked); the
Vite dev-server proxy in `apps/web/vite.config.ts` targeting :3000 is a
separate, unrelated local-dev-loop convenience (`npm run dev --workspace
@ronmacrae/web` against a manually-started `npm run dev --workspace
@ronmacrae/api` on the default port) and was left alone.

**Verified**: full e2e suite (32/32) run clean on :3900 while both the
LAN demo (:3000/:8443) and the Cloudflare tunnel demo (:3001) were left
running the whole time — confirmed healthy immediately before and
immediately after the e2e run, with no restart needed for either.

## Stage 23 — Section 6: global customer identity (DONE)

Real phone normalization, verified-vs-provisional identities, and audited
duplicate resolution — replacing Stage 22's own explicitly-provisional
phone matching with the real thing.

**Data model** (`schema.prisma`): `CustomerIdentity` (normalizedPhone
unique, normalizedEmail nullable, status provisional/verified,
verifiedAt) — holds almost nothing on purpose: just enough to match a
person's Customer rows across businesses together, never any per-business
PII (name/address/notes stay on Customer, business-scoped, as always).
`Customer.identityId` links to it (nullable — a phone that can't be
confidently normalized just has no identity, an honest state, not a
bug). `MergedPhoneAlias` — when the owner merges two identities, the
merged-away one's phone doesn't just vanish; it's recorded here so it
keeps resolving to the surviving identity forever after, rather than
silently re-creating a new identity (and quietly undoing the merge) the
next time someone books with that number.

**Real phone normalization** (`lib/phone.ts`, rewritten): now
libphonenumber-js-based, Jamaica-default but genuinely handles any
country's number, exact-match only (a miss just means a package doesn't
show up grouped with the customer's others — safe; a wrong match between
two different people is the thing this design avoids). Deliberately kept
separate from the older, differently-shaped ad-hoc phone normalizer
already in `modules/auth.ts` (used for User/Rider/Customer.phone storage
and login-by-phone lookup) — unifying those is a real, known follow-up,
not attempted here, since it would mean re-migrating phone storage across
logins/riders/customers for a cleanup outside this stage's scope. Flagged
via a code comment and a spawn_task suggestion rather than done silently.

**Safe email normalization** (`lib/email.ts`, new): trim + lowercase
only — deliberately no Gmail-style dot/plus-address folding, which would
risk treating two different people's real addresses as "the same." Email
is only ever a duplicate-*candidate* signal, never grounds to auto-merge.

**Automatic, deterministic linking — never a "merge"**: every Customer
create/update (`modules/customers.ts`, all three code paths: staff
create, staff update, the public delivery-request upsert) now resolves
the customer's identity by phone as a side effect, best-effort (a failure
here never blocks the actual customer save). Two different businesses'
customers sharing an exact normalized phone land on the same identity
automatically — that's the intended "one global identity" grouping, not
a merge of two already-distinct identities (which stays a separate,
owner-only, audited action — see below). An update that only changes a
customer's name never touches their identity link; one that changes
email-only attaches the email as a signal to the *existing* linked
identity directly (never re-derived from the already-normalized stored
phone, which the new parser can't read anyway — see below).

**Verified vs. provisional**: every identity starts `provisional` —
staff typed this phone into a form, nobody has proven they own it. The
only way to reach `verified` is completing the customer-dashboard's own
phone-OTP flow (Stage 22) — `customer-dashboard.ts`'s verify() route now
marks the identity verified as a side effect of a correct code. Verified
never downgrades: a later provisional-looking write for the same phone
(a different business typing it into a booking form) doesn't undo proof
already established.

**Two more real cross-business privacy bugs found and fixed** (found
because this stage's whole point is "preserving cross-business privacy,"
and Stage 20's own isolation pass didn't reach these):

- **`GET /api/audit` had no business filter at all.** Any staff member at
  any business could read every other business's entire audit trail —
  every job/customer/offer event platform-wide. Fixed: `AuditLog`
  gained a nullable `businessId`, derived automatically in `record()`
  going forward (job/customer/offer entities join to their own
  businessId; rider/user entities are correctly left null — a rider
  being created or a staff login genuinely isn't any one business's
  event), backfilled onto 299 of the 589 derivable historical rows via
  `scripts/backfill-audit-business.mjs` (290 were orphaned — their
  underlying job/customer/offer no longer exists, from this dev
  database's long history of reseeding; correctly left null, not
  guessed at). `GET /api/audit` now requires and enforces the caller's
  own businessId.
- **No owner-wide view existed at all** — meaning there was previously
  no way for the platform owner to review activity *across* businesses,
  including the new identity-merge events this stage adds (which are
  inherently cross-business and don't belong to any one business's own
  audit view). Added `GET /api/owner/audit` (unscoped, `requireOwner`-
  gated) — the first real route to use the `requireOwner` guard that's
  existed, unused, since Stage 20.

**Audited duplicate resolution** (`modules/customer-identity.ts`,
`modules/owner.ts`, both new, owner-only): `GET
/api/owner/customer-identities/duplicates` surfaces identities that
share a normalized email but have different phones — a plausible
same-person signal, never acted on automatically. `POST
/api/owner/customer-identities/:id/merge` combines two identities:
every linked Customer row re-points to the survivor, trust already
established never downgrades (verified beats provisional), the merged-
away phone keeps resolving via `MergedPhoneAlias`, and the whole thing
is one audited action (`ctx.audit.record`, action
`customerIdentity.merge`, meta records both ids, both phones, and the
reason given). Refuses to merge an identity into itself; 404s (not a
different code) on an unknown id.

**Rate limiting**: no new public surface was added — the owner routes
are owner-authenticated, protected the same as every other staff route
by the global per-IP limiter (Stage 21); the OTP surface's own rate
limiting (30s resend cooldown, 5-attempt cap) is unchanged from Stage 22
and is what this stage's "verified" status now actually relies on.

**Migration, verified against the real `dev.db`**: backed up first
(`data/dev.db.bak-stage23-*`). Additive schema push (`identityId` on
Customer, `businessId` on AuditLog, both nullable; new
CustomerIdentity/MergedPhoneAlias tables) confirmed non-destructive by
row count before/after. `scripts/backfill-customer-identities.mjs`
(dry-run by default) linked 75 of 77 existing Customer rows to 75 newly
created (all-provisional) identities — the 2 unlinked rows have
genuinely malformed test-data phone numbers that don't normalize to
anything (an honest "no match," not a bug); every identity created this
way starts provisional, since nothing in historical data proves anyone
actually owns these numbers. `scripts/backfill-audit-business.mjs`
resolved 299 of 589 derivable AuditLog rows (see above).

**Tests**: `apps/api/test/customer-identity.test.ts` (new, 10 tests) —
automatic identity resolution and its "not a merge" distinction across
two businesses sharing a phone, name-only vs. phone-changing updates,
provisional-to-verified via the real OTP flow and that verification never
downgrades, owner-only enforcement (403 for non-owners) on both new
routes, the full duplicate-candidates → merge → alias-still-resolves →
audited round trip (a third business booking with the merged-away phone
afterward lands on the surviving identity, not a new one), self-merge and
unknown-id rejection, and the audit-log business-isolation fix itself
(including the owner seeing both businesses' entries).
`customer-dashboard.test.ts` and `tracking.test.ts` updated for the new
normalizer's real E.164 output (was the old provisional bare-digit form)
and re-verified passing; `customer-dashboard.ts`'s `buildDashboard` now
queries via the indexed CustomerIdentity table instead of Stage 22's
`contains`-prefiltered scan.

**Verification**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 153/153 (143 prior + 10 new); `apps/web` vitest 8/8 + clean build;
full e2e suite (still on the new dedicated :3900, both live demos
confirmed undisturbed) 32/32.

**Honestly unverified — do not represent otherwise**: actual SMS
delivery through a real provider (Twilio, not the dev memory provider)
and a real customer completing this flow with a code that genuinely
arrived on their own phone have NOT been tested on real hardware in this
session. Everything above is verified through the dev/e2e path only
(memory provider; the code read back via Prisma, the same way a real SMS
would have carried it, but never actually sent as one).

**Not done in this stage** (deliberately deferred): no owner-console
UI — `GET /api/owner/customer-identities/duplicates` and the merge route
are fully implemented and tested but have no frontend yet (the same
documented gap as the rest of the owner console since Stage 20: business
creation/listing, rider platform-approval). Unifying `modules/auth.ts`'s
separate phone normalizer with this stage's real one (see above) is a
real, flagged follow-up, not attempted. No Loyverse integration (not
requested for this stage). Sign-in/account linking, messaging redesign,
deleted-orders trash, and rider cash-profile corrections are Stages
24-27, next.

## Stage 24 — Section 5: messaging redesign — three real conversations (DONE)

Replaced the single shared delivery-chat thread (Stage 18) — where a
customer, their rider, and every staff member all read and wrote into one
merged conversation — with the three real pairwise conversations the spec
actually asked for: customer↔dispatch, customer↔rider, rider↔dispatch.
Each has its own authorization (a customer is a party to their own two;
a rider to their own two; staff may write into customer_dispatch and
rider_dispatch, and may only ever *monitor* customer_rider — read, never
post), its own unread count, and its own delivered/read receipts.

**Data model**: `DeliveryMessage` gained `conversationKind` (a proper
enum: customer_dispatch/customer_rider/rider_dispatch), a single
`deliveredAt`/`readAt` receipt pair (replacing the old three separate
readByCustomer/readByRider/readByStaff booleans — every conversation now
has exactly two sides, so "the other side" is unambiguous and one pair
suffices), and a `clientToken` for retry-without-duplicate (unique per
job+conversation, so a client resending the same compose attempt after a
network blip gets the already-sent message back instead of creating a
second one). The 5 real pre-existing messages in `dev.db` were left with
`conversationKind: null` — a deliberate "legacy archive," not guessed
into one of the three new conversations: the old shared thread genuinely
could have meant either audience for a dispatcher/rider message, and
guessing wrong would misattribute real history. Read-only via a new
`legacy` endpoint suffix, visible to everyone who could see the old
thread; nothing new ever lands there again.

**Delivered vs. read, honestly**: `deliveredAt` is set immediately when
the recipient had a live realtime socket connected at send time (rider/
staff — a genuine live-delivery signal), otherwise on their next fetch,
same trigger as `readAt`. Customers have no live channel in this app at
all (the tracking page polls, it doesn't hold a websocket) — so for any
conversation with a customer on the receiving end, delivered and read
land together, honestly reflecting that there's no push channel to them,
not faked to look more granular than it is.

**Two real bugs found and fixed while building this**:

- **Reassignment didn't revoke a rider's already-open realtime
  connection.** A rider's socket joins a job's room (`job:<id>`) at
  connect time and via explicit join requests (both correctly re-
  validated against the *current* assignment) — but nothing previously
  removed a room a socket already held once that assignment changed.
  An unassigned rider whose connection stayed open kept receiving that
  job's live delivery messages and status updates indefinitely, meant
  for whoever has the job now. Fixed: `hub.ts`'s new `leaveJobRoom()`,
  called from both `assignJob` (on a real reassignment) and
  `unassignJob`. A genuine two-socket test
  (`delivery-messages.test.ts`'s "reassignment revokes realtime access")
  confirms a message sent after reassignment never reaches the old
  rider's already-open socket.
- **The global auth allow-list's tracking-message exemption used
  `url.endsWith("/messages")`**, which stopped matching the moment the
  route grew a `/:kind` suffix — every customer POST to a new
  conversation-scoped message endpoint 401'd until this was updated to
  match the new shape. Caught immediately by the rewritten test suite,
  fixed in `auth.ts`.

**Address-change system messages fan out, don't get lost**: an approved
or declined address-change decision posts a system message into
customer_dispatch (the customer always needs to know) and, if a rider is
currently assigned, rider_dispatch too (riders need it for navigation) —
never customer_rider, which isn't the confirmed-operational-change
channel. `mergeCustomerIdentities`-style fan-out, not a 4th conversation
kind.

**Frontend**: `components/delivery-chat.tsx` needed surprisingly little
change (it was already cleanly parameterized by fetch/send functions) —
added `clientToken` generation per send attempt (`crypto.randomUUID()`,
reused automatically across the mutation's own retries via TanStack
Query's `retry: 2`) and a delivered/read indicator on the sender's own
messages. New `components/conversation-tabs.tsx` wraps it: a small
tabbed switcher (with unread badges) across a viewer's up-to-two-or-three
conversations for one job, mounting only the active tab's chat (two
conversations polling in the background when only one is visible isn't
worth the extra requests). All three consumers — the customer tracking
page, the rider dashboard, and the dispatcher's Jobs screen — now render
`ConversationTabs` instead of a single `DeliveryChat`.

**Tests**: `apps/api/test/delivery-messages.test.ts` (rewritten, 24
tests) — conversation separation (a message in one is invisible in
another), staff's monitor-only customer_rider (403 on write, read
succeeds, never marked read, never counted in the staff unread badge),
receipts flipping on the recipient's next fetch, retry-without-duplicate
(including that the same clientToken in two different conversations is
NOT treated as a duplicate), address-change fan-out (with and without a
rider assigned), the reassignment-revokes-realtime-access fix (a real
two-`ws`-client test), conversation closure, address-change review, rate
limiting, and no PIN/phone leakage — plus the two tests carried over
from Stage 18 (rider-job isolation, accountant/viewer monitor-only) now
adapted to the new per-conversation routes. `e2e/specs/delivery-messages.spec.ts`
(rewritten) drives a real browser through the full three-conversation
flow: customer messages both dispatch and the rider on separate tabs,
dispatcher sees and can only reply to customer_dispatch (confirming
customer_rider is genuinely invisible to them until they switch to the
monitor tab, and clearly marked "Monitor-only" there), the address-change
confirmation reaches both the customer and the rider, and the customer's
Customer↔Rider tab picks up the rider's reply live without ever leaking
the dispatcher's separate Customer↔Dispatch reply into it.

**Verification**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 165/165 (153 prior + 24 new/rewritten in delivery-messages.test.ts,
net +12, plus one existing multi-tenancy.test.ts assertion updated for
the new route shape); `apps/web` vitest 8/8 + clean build; full e2e suite
32/32 on the dedicated :3900 port, both live demos confirmed undisturbed
before and after.

**Not done in this stage** (deliberately deferred): no in-app push/ack
protocol for customers — delivered/read stays honestly poll-driven for
them, as noted above; this isn't a gap so much as a property of the app
not having a customer-side realtime channel at all yet. `AddressChangeRequest`
itself wasn't restructured — it stays job-level (not conversation-scoped),
which is correct: an address change is one job-wide fact under review,
not a per-conversation artifact. No UI affordance was added to browse the
legacy archive from the new tabbed interface beyond the raw `/legacy`
endpoint (no route in this session's scope needed it — the archive holds
5 messages total in `dev.db`).

## Stage 25 — Section 7: sign-in / account linking (DONE)

Optional email+password account for a customer, additive on top of the
phone-OTP dashboard session (Stage 22) and the CustomerIdentity it's
built on (Stage 23) — never a replacement for the phone flow, which stays
fully available regardless of whether someone claims an account.

**Account-claim, deliberately gated by an already-proven phone**:
creating an account (`POST /api/customer-account/claim`) requires holding
a valid customer-dashboard Bearer token — i.e. you must have already
completed the phone-OTP flow for that phone number. This means claiming
credentials can never itself be used to take over somebody else's
identity by guessing an email; the hard part (proving phone ownership)
was already done by Stage 22's own mechanism. Login afterward
(`POST /api/customer-account/login`) issues the *exact same* token type
(`CustomerDashboardTokenPayload`) the OTP flow does, scoped to the
account's own identity — every existing dashboard route (including the
whole customer-dashboard aggregation from Stage 22) works completely
unchanged for an account-based session, no special-casing anywhere else
in the system.

**Data model**: `CustomerAccount` (one per CustomerIdentity, unique
email, scrypt password hash via the existing `lib/password.ts` — the same
one User accounts already use), `CustomerEmailCode` (the email-channel
counterpart to Stage 22's phone-channel `CustomerAccessCode` — same
shape, same 10-minute expiry / 30-second resend cooldown / 5-attempt cap,
factored into a shared `lib/verification-code.ts` both now import from,
rather than duplicating the hashing/generation logic a second time).

**A real, previously-nonexistent capability had to be built first: email
sending.** This codebase had no email provider at all — only SMS/
WhatsApp (`@ronmacrae/notifications`'s core.ts). Added a small, separate
`email.ts` in the same package: an `EmailProvider` interface and a
`MemoryEmailProvider` (dev-log only, same zero-external-credentials
philosophy as the SMS memory provider) — deliberately NOT wired to any
real SMTP/SES/SendGrid/Postmark integration, since none of those
credentials exist in this environment and faking one would misrepresent
what's actually been tested. The `EmailConfig.provider` type is a single
literal (`"memory"`), not an open string, so it's structurally impossible
to configure a provider that doesn't actually exist — an honest
constraint, not just a comment. These verification/reset emails are
simple, synchronous, immediate-feedback sends — deliberately NOT run
through the async outbox+queue machinery built for delivery-status
blast notifications, which is a different shape of problem.

**Anti-enumeration, consistently applied**: login gives the exact same
generic "Incorrect email or password" for a wrong password and for an
email with no account at all (verified by asserting the two JSON
responses are byte-identical, not just same status code). Requesting a
password-reset code always returns `{ok:true}` and never actually sends
anything for an unknown email — verified by asserting nothing was added
to the email provider's sent log for an unrecognized address.

**Frontend** (`pages/my-packages.tsx`, extended): the phone-entry step
gained a "Have an account? Sign in with email" link into a real email+
password form, with its own "Forgot password?" → request-code → reset
flow. Inside the dashboard itself, a new `AccountPanel` component shows
account status (fetched via the new `GET /api/customer-account/status`)
— collapsed to a single low-key link for someone with no account yet
("Create an account so you don't need a text code next time"), an
inline claim form when opened, an email-verification prompt if claimed
but unverified, and a quiet "Signed in as X" line once verified. All of
it optional, all of it out of the way of the actual packages list.

**Instagram login — investigated honestly, not implemented, not faked**:
genuinely infeasible to build in this session, for concrete reasons, not
just "out of scope":
- A real Meta Developer App (with the Instagram product configured) is
  required, plus **App Review** from Meta for any non-trivial scope — an
  external, human-gated approval process this session cannot complete
  (no registered Meta developer account exists here, and one would need
  to belong to the actual business, not this session).
- Instagram's current login flow (Instagram Business Login — the older
  Instagram Basic Display API was deprecated Dec 2024) **requires the
  logging-in account to be a Business or Creator account**. A regular
  personal Instagram account — what most real customers would have —
  cannot authenticate this way at all. That alone makes it a poor fit
  for a general customer-facing "log in with Instagram" button, not
  just an implementation detail.
- Even with a working OAuth flow, the scopes available don't reliably
  return an **email address** — only a user id and basic profile. Since
  this whole identity system (Stage 23) is built around phone+email,
  that would mean still prompting for an email anyway, undercutting
  much of the convenience the feature would supposedly add.
- OAuth needs a real, permanent, registered HTTPS redirect URI — this
  session's LAN/tunnel URLs are ephemeral dev previews, not something
  Meta's app config could point at durably.
- Real client credentials (an Instagram/Meta App ID + Secret) would be
  needed, the same way `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` are for
  SMS — none exist in this environment, and, as with SMS, faking the
  integration to *look* implemented would misrepresent what's verified.

**What a real implementation would need**, if the business later wants
to pursue it: register a Meta Developer App with the Instagram product,
complete App Review for the needed scope, add
`INSTAGRAM_CLIENT_ID`/`INSTAGRAM_CLIENT_SECRET` config (mirroring the
`TWILIO_*` pattern already established in `config.ts`), implement the
OAuth redirect+callback routes, and handle the no-guaranteed-email case
by still collecting one on first login. None of that exists yet, and no
placeholder UI button was added pointing at it — a disabled-looking
button that does nothing on click would be worse than no button at all.

**Tests**: `apps/api/test/customer-account.test.ts` (new, 8 tests) —
claim requires a valid dashboard token, duplicate-account and duplicate-
email rejection, email-code wrong/reuse/cooldown handling, login issuing
a token that genuinely works against the existing dashboard route, the
byte-identical generic error for wrong-password vs. no-such-account,
and the full password-reset round trip (old password stops working, new
one works) plus the no-enumeration guarantee (nothing sent for an
unknown email). `e2e/specs/my-packages.spec.ts` (extended, 1 new test)
covers the real-browser navigation: reaching email sign-in from the
phone step, the generic wrong-credentials error, reaching the reset-
code-entry step, and both "back" paths — deliberately stopping short of
completing a real send/verify round trip in the browser, for the same
reason the phone-OTP e2e coverage does (no legitimate way for a
black-box browser test to read a real email/SMS code; the full round
trip is covered at the API-integration level instead, which can read it
off the memory provider's own log the way a real inbox would have shown
it).

**Verification**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 173/173 (165 prior + 8 new); `apps/web` vitest 8/8 + clean build;
full e2e suite 33/33 (32 prior + 1 new), both live demos confirmed
undisturbed before and after. `dev.db` schema push was purely additive
(two brand-new tables, no column changes to anything existing) —
confirmed by row count: all 77 customers, 67 jobs, 75 identities
untouched.

**Honestly unverified**: real email delivery through any actual provider
— only the dev memory provider (in-process log) has been exercised;
nothing has been sent to a real inbox. Combined with Stage 22/23's own
still-unverified real-SMS caveat, this app's entire "prove you own this
contact channel" story remains dev/memory-provider-only end to end —
worth real-device/real-inbox testing before this is relied on in
production.

**Not done in this stage**: no "change password while already signed
in" flow beyond reset-via-email-code (a logged-in customer who wants a
new password today uses the same forgot-password flow as anyone else —
a deliberate scope cut, not an oversight: it's one fewer form for the
same outcome). No account deletion/deactivation. No Instagram
implementation, for the concrete reasons above. No billing anywhere
(not requested for this stage). Deleted-orders trash and rider cash-
profile corrections are Stages 26-27, next.

## Stage 26 — Section 8: deleted-orders trash (DONE)

Soft-delete only, ever. There was no order-deletion capability of any
kind in the product before this stage — no route, no button, nothing;
"delete" always meant a status transition (cancelled) that keeps the
order visible forever. This stage adds a real trash, and deliberately
never a real `DELETE`.

**Why "never" isn't a simplification, it's the actual safety property**:
every row referencing a job — `CodEvent` (the cash ledger), `JobEvent`
(the audit trail), `DeliveryMessage`, `AddressChangeRequest`, `Proof`,
`TrackingLink`, `JobOffer`, `RiderAssignment`, `RouteStop` — uses
`onDelete: Cascade` back to `Job`. A real delete would take the entire
financial and audit trail with it. So `Job` gained `deletedAt`/
`deletedById`/`deleteReason` (all nullable) and nothing else changed;
the row, and everything pointing at it, stays exactly as it was,
forever, whether restored or not.

**30-day restore window, computed rather than stored**: instead of a
`purgedAt` flag some background job has to remember to set,
`jobs/trash.ts`'s `isPurged()` just compares `deletedAt` to now. This is
always correct — immune to a missed cron tick, a process that never runs
for 30 days straight (this dev setup's own `QUEUE_DRIVER=memory` would
lose an in-memory delayed job on every restart), or no scheduler at all.
`scripts/purge-deleted-jobs.mjs` is the "scheduled purge" the spec asks
for in spirit: it deletes nothing (there's nothing to delete) — it
records one `AuditLog` entry ("job.purged") the first time each job
crosses the 30-day mark, a real, idempotent, permanent compliance record
of exactly when restore stopped being offered. Safe to run from any real
scheduler on any cadence, or never — restore-window enforcement doesn't
depend on it either way.

**Two real safety rules beyond "just soft-delete it"**, both found while
thinking through what "trash" should actually allow:

- **An actively in-flight job can't be trashed.** `assertDeletable`
  blocks deletion while the job is in any of `ACTIVE_JOB_STATUSES`
  (assigned/accepted/picked_up/in_transit/delivering/location_changed/
  no_answer) — cancel or let it resolve first. A rider mid-delivery, or
  a customer expecting a package, must never have their order silently
  vanish from staff's working view.
- **Unresolved cash blocks deletion too.** `assertNoOutstandingCod`
  refuses to delete a job whose `codStatus` is `collected`, `handed_in`,
  or `disputed` — cash that's changed hands but isn't reconciled yet, or
  is under active dispute. Deleting an order must never look like a way
  to make an outstanding COD discrepancy quietly disappear from the
  ordinary working view. `pending_collection` (nothing collected — the
  default for every non-COD job too) and `approved` (already
  reconciled) are both fine.

**Trash is invisible to ordinary operational views, on purpose exactly
this narrowly**: `getJobRow` — the one function nearly every job action
(assign, transition, messages, proofs, the job detail route) goes
through — now excludes a deleted job by default, a single change that
makes it uniformly a 404 everywhere without touching each of those call
sites individually. The public tracking page and delivery messaging
(customer/rider/staff, all three conversations) close entirely for a
trashed job too — same "no longer valid" response a customer would see
for an expired link, so "deleted" and "expired" look identical from
their side, never a customer-visible signal that staff trashed their
order. Restoring undoes all of this immediately; nothing about the
messages, tracking link, or job state was ever touched.

**Reports, COD reconciliation, and the audit log deliberately never
filter by `deletedAt`** — the entire point of the spec's "preserve
ledger/dispute/audit records." An accountant reconciling COD, or running
an operating report, sees a trashed job's real financial history exactly
as if it had never been trashed. Verified directly: a job trashed after
its COD was approved still appears in `/api/cod` and
`/api/reports/summary` for an accountant, and its `CodEvent` rows are
still there in the database, untouched.

**Frontend**: a "Delete" button on the Jobs screen (admin/dispatcher
only, and only shown when the job is actually deletable — mirrors the
backend rule so it never offers an action that would just 409), gated
by `window.confirm` (this codebase's own established pattern, already
used for zone deletion) plus an optional reason via `window.prompt`. A
new `/trash` page (all four staff roles can view; only admin/dispatcher
can restore) lists every trashed order with who deleted it, when, why,
and a "N days left" / "restore window closed" badge.

**Tests**: `apps/api/test/jobs-trash.test.ts` (new, 13 tests) — delete
removes it from the normal list/detail while keeping the trash entry
and the underlying row; both safety rules (active-status block,
each of the three cash-still-outstanding statuses); double-delete and
non-admin/dispatcher rejection; audited with the reason in `meta`;
restore brings it back everywhere and clears the trash entry; restore
rejects a job that was never deleted, and rejects (410) one whose
30-day window has already passed — while confirming the row itself
was never actually removed and the trash listing still shows it,
correctly marked `purged`; trash is business-scoped (a second business
can neither see nor restore another's trashed job); and the two
"never filtered" guarantees (COD board + reports; messaging/tracking
close entirely). `e2e/specs/jobs-trash.spec.ts` (new) drives a real
browser through the whole loop — delete via the confirm+prompt dialogs,
confirm it vanishes from Jobs, find it in Trash with the reason and
"30 days left," restore it, confirm it's back in Jobs.

**Verification**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 186/186 (173 prior + 13 new); `apps/web` vitest 8/8 + clean
build; full e2e suite 34/34 (33 prior + 1 new), both live demos
confirmed undisturbed. `dev.db` schema push was purely additive
(three new nullable columns on Job, no changes to anything else) —
confirmed by row count: all 77 customers/67 jobs untouched.
`scripts/purge-deleted-jobs.mjs` dry-run verified clean against the
real `dev.db` (nothing past 30 days yet, as expected).

**Not done in this stage**: no bulk delete/restore (one order at a
time); no dedicated detail view for a trashed job beyond the trash
list's own summary card (clicking through to the ordinary job-detail
route 404s for a deleted job, by the same `getJobRow` exclusion that
makes trash work everywhere else — a deliberate, disclosed trade-off
given the time this stage had, not a bug); no configurable retention
window (30 days is fixed, matching the spec). Rider cash-profile
corrections are Stage 27, next.

## Stage 27 — Section 9: rider cash-profile corrections (DONE)

No schema changes at all — the entire cash profile is derived fresh
from existing `Job`/`CodEvent` data at read time, nothing new stored.
Before this stage there was no rider cash-profile summary of any kind:
`API.bearer.cash` existed as a route path in `contracts/routes.ts` but
had never actually been implemented — every per-job COD figure existed
(from Stage 12), but nothing aggregated them into a real picture of what
one rider is holding, has handed in, or is owed.

**The bug the spec named — "Handed in must not auto-clear confirmed-owed
amount" — is fixed by construction, not by patching an existing
counter**: there never was a stored, mutable "confirmed owed" counter to
begin with (no aggregate existed at all), so the actual design decision
this stage made was to never introduce one. Every bucket
(`collected`/`handedInUnconfirmed`/`confirmed`/`disputed`) is a live
`SUM()` over independent Job rows, grouped by that job's own current
`codStatus`, computed fresh on every read. A hand-in action only ever
updates the one job it's called on; it has no shared running total to
disturb, so a `confirmed` total built from a completely different,
already-approved job is structurally untouched by it — proven directly
in `cash-profile.test.ts`'s own test of exactly this scenario (record
and confirm the total before, hand in an unrelated job, assert the
`confirmed` total after is byte-identical).

**Five real components, not three**: `collected` (holding cash, not yet
handed to the office), `handedInUnconfirmed` (rider says it's in, no
accountant sign-off yet), `confirmed` (accountant-approved, settled),
`disputed` (under active dispute — falls back to the recorded-collected
amount when a dispute was raised before any hand-in ever happened, so a
real dispute never silently shows $0), and `earningsPayable` (what the
business owes the rider for their own completed work) — kept
structurally separate as its own field, never summed into or subtracted
from the COD buckets above it. Those two money flows run in opposite
directions (the rider owes the business COD cash; the business owes the
rider their pay) and conflating them was exactly the kind of
double-counting the spec called out.

**A sixth figure, not explicitly named but a direct consequence of
"exact money arithmetic"**: `handoverVariance` — the real difference
between what a rider said they collected and what the office actually
received, across every job that's reached at least a hand-in. A
shortage shows negative, an overage positive, and it's a genuine sum
over real per-job amounts (`codHandedInAmount - amountCollected`), never
netted away silently inside either bucket's own total (the schema's own
`Job.codHandedInAmount` doc comment already flagged this gap; this
stage is what actually surfaces it).

**Honest about `earningsPayable`**: computed the same way reports.ts's
existing "estimated earnings" already does — pay rate × delivered jobs,
scoped to deliveries actually made *for that business* (a rider's pay
rate is global, per Stage 20's own established design, but a business
must never be shown earnings for work done for a different business).
Explicitly labeled as an estimate, `null` (not $0) when no pay rate is
configured, and documented plainly: no payout-tracking exists yet
(`Payout`/`PayoutLine` are real models, completely unused by any route),
so this figure never decreases as money is actually paid out. Building
real payout approval/marking-as-paid is a genuinely separate feature,
not attempted here.

**Scoped per business, always** — a rider can hold active memberships
at more than one business (Stage 20); cash owed to business A is never
summed with cash owed to business B, on either side. The rider's own
view (`GET /api/bearer/cash`) returns one profile per active
membership, never combined. The staff view (`GET /api/riders/:id/cash`)
returns only the caller's own business's slice — 404, not 403, if the
rider has no membership there at all, even if they work for other
businesses (the same cross-business boundary rule used everywhere else
in this codebase).

**Frontend**: a collapsible "Cash summary" card on the rider's own
dashboard (hidden entirely when there's genuinely nothing to show —
never an empty card taking up space for a rider who's never touched
COD), one business at a time. A matching "💵 Cash" panel on the
dispatcher's ops board, alongside the existing "Route queue" toggle —
same expand-in-place pattern, staff-scoped to their own business
automatically.

**Tests**: `apps/api/test/cash-profile.test.ts` (new, 7 tests) — each
bucket sums only its own status's jobs; the hand-in-doesn't-clear-
confirmed test described above; the disputed-with-no-prior-handover
fallback; a real shortage-and-overage variance computation; earnings
payable null with no rate configured and correctly scoped to
deliveries-for-this-business-only when one is; and staff scoping (own
business only, 404 for a rider with no membership there).
`e2e/specs/rider-cash.spec.ts` (new) drives a real browser through a
full COD lifecycle with a fresh rider (not the shared seed rider other
specs already touch, so the figures asserted are exact, not just "at
least") — collect, hand in short, and confirm both the dispatcher's
ops-board cash panel and the rider's own dashboard show the identical
J$2,900 handed-in figure and the shortage variance.

**Verification**: `npm run typecheck --workspaces` clean; `apps/api`
vitest 193/193 (186 prior + 7 new); `apps/web` vitest 8/8 + clean
build; full e2e suite 35/35 (34 prior + 1 new), both live demos
confirmed undisturbed. No `dev.db` migration needed — this stage adds
no schema.

**Not done in this stage**: no real payout-approval workflow (marking
earnings as actually paid, which would let `earningsPayable` genuinely
decrease over time) — `Payout`/`PayoutLine` remain unused models, a
real, separate feature; no date-range filtering on the cash profile
(all-time totals only — reasonable at this data volume, would matter
at real scale); no bulk/CSV export of the cash profile (reports.ts's
existing CSV export is the closest equivalent today, and doesn't cover
this new aggregation). This was the last of the ten feature sections
(1-9 plus verification/handoff) from the original request — Stage 28
is the final cross-cutting verification and handoff pass across
everything built in Stages 19-27.

## Stage 28 — Section 10: final verification and handoff (DONE)

Not a rerun of each stage's own tests (already green, individually,
after every one of Stages 19-27) — this pass specifically went looking
for the *seams between* stages, the kind of gap a feature built later
can leave in something built earlier without either stage's own test
suite ever noticing, because neither one was looking at the other.

**A real bug found and fixed**: `mergeCustomerIdentities` (Stage 23)
predates `CustomerAccount` (Stage 25) entirely. `CustomerAccount.
identityId` is unique and `onDelete: Cascade` back to `CustomerIdentity`
— so merging away an identity that had a real, claimed account (email +
password) would have silently cascade-deleted that customer's login
credentials the moment an owner merged a duplicate, with no warning to
anyone. Nothing in either stage's own test suite ever exercised this,
because Stage 23's tests were written before CustomerAccount existed,
and Stage 25's tests never touched merge. Fixed in `customer-identity.ts`:
the source's account (if any) is re-pointed to the surviving identity
*before* the source is deleted, the same way `MergedPhoneAlias` and
`Customer` rows already were; if *both* identities independently claimed
their own account, the merge is refused outright (409, nothing touched)
rather than guessing which email/password should survive — that's a
real judgment call for a human, not something to automate. Two new
tests in `customer-identity.test.ts` cover both paths: the account
survives and keeps working post-merge, and a genuine two-account
conflict is refused cleanly with both sides left completely untouched.

**Two more seams checked and confirmed correct** (nothing was broken —
worth pinning down with a real test rather than leaving it as
reasoning), in the new `apps/api/test/stage28-integration.test.ts`:

- **Trash (26) + customer dashboard (22)**: a job trashed by staff
  disappears from the customer's own cross-business package dashboard
  immediately, and restoring it brings it straight back — confirmed
  with a real customer-dashboard session end to end, not just inferred
  from the `deletedAt: null` filter added back in Stage 26.
- **Trash (26) + rider cash profile (27)**: a job's already-*approved*
  COD (settled, historical) keeps counting in the rider's `confirmed`
  cash bucket even after the underlying order is trashed — the same
  "reports/ledger views never filter by deletedAt" rule Stage 26
  established for `/api/reports` and `/api/cod`, now proven true for
  the cash profile too, which didn't exist yet when that rule was
  written.

**Full clean re-verification, everything together**: `npm run
typecheck --workspaces` clean across all 6 workspaces; `apps/api`
vitest 197/197 (193 prior + 4 new: 2 identity-merge/account tests + 2
stage28-integration tests); `apps/web` vitest 8/8 + clean build; full
e2e suite, fresh `e2e-test.db`, on the dedicated `:3900` port, **35/35**
— every spec from every stage of this entire session, run together, in
one clean pass.

**Data-preservation audit — the whole Stage 20-27 arc, not just one
stage**: compared the real `dev.db` against `dev.db.bak-multitenancy-
20260910-235645`, the backup taken immediately before Stage 20's
multi-tenancy migration (the very first schema change of this whole
arc, and the moment the user explicitly asked for a backup first).
Every real table's row count either stayed the same or grew — never
shrank:

| Table | Before Stage 20 | Now | 
| --- | --- | --- |
| Job | 65 | 67 |
| Customer | 76 | 77 |
| Rider | 1 | 1 |
| User | 6 | 7 |
| DeliveryMessage | 0 | 5 |
| CodEvent | 15 | 21 |
| AuditLog | 1264 | 1329 |
| TrackingLink | 24 | 25 |
| Zone | 3 | 3 |
| JobOffer | 17 | 20 |
| RiderAssignment | 21 | 24 |
| JobEvent | 175 | 220 |

Growth throughout is consistent with genuine real usage over the
session (the LAN and Cloudflare-tunnel demos being actually used, by
the user and the friend given tunnel access, the whole time this work
was happening) — never a reset, never a reseed, exactly as instructed.
All 5 original demo staff accounts, the one real rider (Kei Bearer),
and the one real business (Ronmacrae Distributions, still the only row
in `Business`) are all still exactly as they were.

**Live demo, verified visually, not just by health check**: logged
into the running Cloudflare-tunnel demo (still on `https://expense-
lines-courses-diet.trycloudflare.com` — the tunnel restarted once
mid-session after cloudflared died independently; see Stage 23's
notes) as the real admin account and confirmed, by eye, against real
production-shaped data: the Trash page (correct empty state, real
copy); the Ops board's new "Cash" panel, expanded, showing genuinely
computed figures — J$35,000 handed-in-unconfirmed across 8 real jobs
(cross-checked against the COD-awaiting-approval list showing the same
8 jobs), and a real J$-4,850 shortage on past handovers, both derived
live from real `CodEvent`/`Job` data, not fixtures; and `/my-packages`'
phone-entry step plus its "Sign in with email" form, both rendering
correctly.

**Stray-code sweep**: no `TODO`/`FIXME`/stray `console.log`/`debugger`
anywhere in `apps/api/src`, `apps/web/src`, or any package's `src` —
the only `console.log` calls in the whole tree are `seed.ts`'s
intentional CLI output.

**The original ten-section request, in full**: sections 1-2 (Stage 19),
3 (21), 4 (22), 5 (24), 6 (23), 7 (25), 8 (26), 9 (27), plus the
multi-tenancy foundation (20) the user explicitly asked to build first
once it became clear sections 4/6/7/9 needed it, and this stage (10,
the verification/handoff itself) — every section from the original
request has now shipped, been tested, and been documented.

**Honestly, what remains unverified or deliberately not built —
collected in one place**:
- **Real SMS and real email delivery** — every OTP/verification/
  password-reset code in this system has only ever been exercised
  through the dev memory providers (logged in-process, read back via
  Prisma/the provider's own `sent` log in tests). Nothing has been sent
  to, or received by, a real phone or a real inbox. This is the single
  most important thing to verify before any of the phone-OTP or
  email-account flows are relied on with real customers.
- **Instagram login** — investigated (Stage 25), not implemented: needs
  a real registered Meta Developer App, App Review, only works for
  Business/Creator Instagram accounts, and doesn't reliably return an
  email even when it works. No placeholder button exists.
- **No owner-console UI** — `requireOwner`-gated routes exist (business
  creation is still API-only, rider platform-approval is still
  API-only, the identity-duplicates/merge routes from Stage 23 have no
  frontend). The owner can do everything via the API today; nothing
  has a screen yet.
- **No real payout-approval workflow** — `Payout`/`PayoutLine` (Stage
  27) remain real, unused models; `earningsPayable` is an honest
  estimate that never decreases as money is actually paid out.
- **`modules/auth.ts`'s separate, older phone normalizer** was never
  unified with `lib/phone.ts`'s real one (Stage 23) — flagged as a
  background task at the time (`task_c0c94e29`), not attempted, since
  it would mean re-migrating User/Rider/Customer phone storage and
  login-by-phone lookup for a cleanup outside any single stage's scope.
- **No billing anywhere**, per the user's own standing instruction —
  never touched.
- **Not deployed** — the LAN demo (`https://192.168.183.146:8443`) and
  the Cloudflare tunnel demo are both still running, per the user's own
  "keep it running until I tell you to stop" instructions from earlier
  in this session; neither has been stopped or cleaned up.

**Nine commits landed this session's multi-tenancy arc**, each
independently verified and documented before the next began: the
infra port-separation fix, then Stages 20 through 27. This stage adds
the tenth: a final cross-cutting verification pass, not a new feature.

## Stage 29 — new follow-up request: simplify the rider/dispatcher/customer workflow (DONE)

A **separate request from the user**, made after Stage 28's handoff —
not a continuation of the original ten sections. The ask was blunt:
the app should feel extremely simple to operate, and eight specific
things weren't. Reviewed the actual built app against each of the
eight points before touching anything; fixed only what was genuinely
missing or conflicting, left working things alone.

**1 — the confusing second "Accept Job" step**: found the real cause.
Accepting an offer (`POST /api/bearer/offers/:id/accept`) moved the job
to `assigned`, and the rider dashboard's `primaryActionFor` then showed
a *second* "Accept job" button for `assigned` jobs before they could do
anything else — a rider who had just said yes to an offer was made to
say yes again. Fixed at the source: offer-accept now claims the job
straight to `accepted` (`offers.ts`), skipping the intermediate status
entirely. A dispatcher's *direct* assignment (no offer involved, via
`assignJob`) still lands on `assigned` and still needs the rider's one
"Accept job" tap — that path never had an offer to stand in for it, so
it keeps its own single accept step. Both paths now cost the rider
exactly one accept, never two.

**Collapsed the pickup step, not removed it**: `picked_up` and
`in_transit` stay real, distinct statuses server-side (customer
notifications, PIN visibility, and location-sharing windows all key off
`in_transit` specifically, and removing it would have meant touching
five other files' worth of behavior for no real benefit). Instead the
rider-facing "Confirm pickup" button chains two transition calls
(`picked_up` then immediately `in_transit`) from the frontend in one
tap. If the second call ever fails mid-chain, the job is left at
`picked_up` and a plain "Start delivery" fallback button appears — the
rider is never stranded with no visible next step, they just see one
extra (rare) tap instead of losing progress.

**Cash defaults + "Record Collected" folded into delivery confirmation**:
`transitionJob`'s existing `cashDefault` (full expected amount unless
overridden) already existed for the `amountCollected`/`paymentStatus`
fields, but nothing wired it to `codStatus` — a COD job stayed at
`pending_collection` even after being marked delivered, so the rider
still had to find and use the separate "Record collected" button
afterward. Fixed: delivering a COD job still at `pending_collection`
now also flips `codStatus` to `collected` (with a matching `CodEvent`)
in the same transaction. The rider-dashboard "Confirm delivery" sheet
gained an editable cash-collected field, pre-filled from the order
total — the default the user asked for, changeable when the customer
actually paid something different. `CodPanel` on the rider's job card
lost its "Record collected" button/form entirely (now redundant) and
kept only "Confirm Cash Drop-Off" for the hand-in step.

**8 — dispatch approves cash drop-off**: `cod.ts`'s `approve` route was
`admin`/`accountant`-only; the user was explicit that dispatch presses
this button day-to-day. Added `dispatcher` to the approver list, but
split it from a separate `disputer` (still `admin`/`accountant`-only)
rather than widening one shared preHandler — disputing a mismatch is a
deliberate escalation, not routine reconciliation, and conflating the
two would have accidentally let dispatch dispute their own approval.
`cod.tsx` mirrors this: `canApprove` now includes dispatcher, `canDispute`
doesn't. The accountability trail the user asked for (who confirmed, who
approved, timestamps) already existed in full — `CodEvent` rows plus
`Job.codApprovedById/codApprovedByName/codApprovedAt` — nothing needed
there.

**6 — Customer Unavailable**: this was already a real transition
(`no_answer`, non-terminal, notifies dispatch via the existing
job.state broadcast) — the gap was purely that it was labeled "Not
Answering" and buried behind a "show more" toggle alongside "Customer
Changed Location" and "Failed". Pulled it out into its own
always-visible, distinctly-styled button during any delivery-attempt
status (`picked_up`/`in_transit`/`delivering`/`location_changed`), with
confirmation copy that says plainly it never marks the delivery
complete.

**4 — Available Jobs**: same finding as above — the mechanism (an
offer the rider can accept, which then moves into their active
workflow) already existed under the label "Job offers", positioned
below Route Queue/Cash Summary. Renamed to "Available Jobs" and moved
above everything else on the dashboard, since accepting new work is the
most actionable thing an idle rider can do.

**5 — messaging visibility**: the three-conversation infrastructure
(Stage 24) was already complete end to end — the rider dashboard's
"Message customer" button already opened both a Customer and a
Dispatch tab via `ConversationTabs`, it just *said* "Message customer",
which hid that dispatch was in there too. Renamed to "💬 Messages".
Every conversation tab is now labeled from each viewer's own
perspective (`labelFor` prop on `ConversationTabs`) — a rider sees
"Customer"/"Dispatch", a customer sees "Dispatch"/"Rider", staff sees
"Customer"/"Customer & Rider"/"Rider" — instead of the same generic
"Customer ↔ Rider" pairing shown to everyone regardless of which side
they're on. Real gap found and fixed: `customer_rider` closed to new
messages the instant a job went terminal, same as every other
conversation — the user's own spec ("for up to 24 hours after the
delivery") needed a genuine behavior change, not just a label fix.
Added `conversationOpenFor(kind, status, completedAt)` in
`delivery-messages.ts`: every kind still closes instantly at terminal
status *except* `customer_rider`, which stays open until 24 hours past
`completedAt`. Wired into all six read/write routes that previously
computed `open` from `!TERMINAL_JOB_STATUSES.includes(status)` directly
(staff, rider, and customer/tracking-token sides). Also found the nav's
unread badge (`isAlertWorthy` in `lib/realtime.tsx`) never counted
`delivery_message` events at all — a rider or dispatcher had no
app-wide signal that an unread message existed anywhere. Added it,
skipping a rider's own just-sent messages (there's only ever one rider
session) but always counting for staff (a shared role across several
real people).

**2 — delivery date/time defaults**: found both booking forms defaulted
to blank. The staff "New Order" form (`new-job.tsx`) had a date field
but no time field at all — `scheduledAt` was silently hardcoded to
local noon whenever a date was entered, with no way to change it. Added
a real time input (defaulting to 12:00) and defaulted the date field
itself to today via `makeEmptyForm()` (a function, not a static
constant, so "today" is recomputed on every reset). The public booking
form (`book.tsx`) had a single `datetime-local` field defaulting to
blank; defaulted it to today at 12:00 via the same local-time
convention. Either field stays fully editable, per the user's own
"can change it, but doing nothing books for noon today" spec.

**7 — address search accuracy**: this took the most digging, and found
a genuine, embarrassing bug. The zero-credential offline fallback
(`simulated.ts`, meant only for dev/CI preview when no real geocoding
key is configured — which is this deployment's actual current state,
since `GOOGLE_MAPS_API_KEY`/`JAMNAV_API_KEY` are both empty in `.env`)
had **Basseterre — the capital of St. Kitts, not a Jamaican town at
all** — hardcoded as a known Jamaican place. Several genuinely
Jamaican places were also mislabeled with the wrong parish: Moore Town
(actually Portland, was St. Catherine), Old Harbour (actually St.
Catherine, was St. Ann), Linstead (actually St. Catherine, was St.
Elizabeth), Half Way Tree/Constant Spring/Harbour View/New Kingston
(actually St. Andrew, were St. Catherine/Kingston depending on the
entry) — several distinct real places had also been bundled under one
shared regex/point, guaranteeing at least one of them resolved to
somebody else's location. Rewrote the list as one real place per entry,
each independently correct. Beyond the fallback data itself: restricted
both real providers to Jamaica (`countrycodes=jm` on OSM, `region=jm` +
`components=country:JM` on Google) so an unrestricted global search
can't match a same-named place in another country in the first place,
and added a belt-and-braces bounding-box check
(`filterResultInJamaica`/`filterResultsInJamaica` in `factory.ts`, using
the existing but previously-unused `inJamaica` helper from `jamnav.ts`)
that rejects *any* provider's result outside Jamaica's bounding box
before it's ever surfaced, regardless of how confidently the provider
returned it. Per the user's explicit "I'd rather it not suggest an
address at all than suggest incorrect locations": `SimulatedProvider
.searchAddresses` no longer returns a hash-jittered guess for a query it
doesn't recognize — it returns nothing, and the frontend's existing
"no suggestions matched, place a pin manually" path (already built,
already tested) handles that honestly. `geocode()` (singular, used only
internally by the composite chain, never called directly by any route)
keeps the old deterministic-hash behavior — nothing external depends on
it returning non-null.

**3 — rider job notification / job details**: checked against the spec
line by line and found this one already met. `OfferCard` (pre-accept)
shows pickup/destination area, item summary, rider earnings, delivery
fee, and cash-to-collect, all in one card with no extra taps.
`RiderJobCard` (post-accept) additionally shows the full pickup and
destination addresses, a "📍 Navigate" deep link (opens the device's own
maps app), the delivery PIN once visible, and instructions. No changes
made here.

**Verification**: `npm run typecheck --workspaces` clean across every
workspace (the `@ronmacrae/e2e` "missing script" line is a pre-existing,
unrelated packaging gap, not a real typecheck failure — that workspace
has no `typecheck` script at all). `apps/api` vitest 198/198 (2 tests
updated for the intentional offer-accept status change, 1 new test for
the 24h messaging grace window). `apps/web` vitest 8/8 unchanged.
`packages/geo` vitest 21/21 (11 new — no-fabrication on
`searchAddresses`, corrected-parish regression guards, and the
bounding-box filter, tested via exported helpers rather than poking the
composite provider's private chain). `npm run lint` reports the same 15
pre-existing, unrelated errors as before this stage (verified via `git
stash` + re-lint) — zero new lint errors introduced. Full e2e suite
**35/35** on a freshly reset `e2e-test.db` (five specs needed updates
for the intentional behavior/label changes: `offers.spec.ts`,
`cod.spec.ts`, `delivery-messages.spec.ts`, `rider-dashboard.spec.ts`,
plus comment/copy touch-ups in `realtime.spec.ts` and
`multi-job-notifications.spec.ts`). A full-suite run against the
session's *accumulated* `e2e-test.db` (grown across several of this
stage's own manual re-runs, not a code defect) hit the seeded rider's
daily-capacity ceiling and produced spurious failures — confirmed as a
pre-existing test-data-accumulation artifact, not a regression, by
reproducing it and then clearing it with a fresh db.

**Not done in this stage**: the LAN demo and Cloudflare tunnel demo
(both still running per the user's standing "keep it running" instruction
from earlier in the session) still serve the pre-Stage-29 build — the web
app was rebuilt locally to drive e2e tests against real frontend
behavior, but neither running demo process was rebuilt or restarted,
since that's disruptive and wasn't asked for. For genuinely
Waze/Google-quality address accuracy in production (rather than the
now-corrected but still approximate offline fallback), a real
`GOOGLE_MAPS_API_KEY` and/or `JAMNAV_API_KEY`+`JAMNAV_ENABLED=1` still
need to be supplied in `.env` — nothing here can substitute for an
actual geocoding credential.
a tenth.

## Stage 30 — multi-merchant public ordering, cash-by-merchant, settlements (DONE)

A different scale of request from Stage 29: a 103-section spec asking for
a full multi-merchant public-order → dispatch → multi-rider delivery →
payment-collection → rider-cash-accountability → merchant-settlement
platform, written against a Supabase/RLS/Edge-Functions mental model that
doesn't match this app (Fastify + Prisma + custom JWT auth + a custom
WebSocket hub — no Supabase anywhere). Corrected that once, in one line,
per the user's own explicit "don't stop to ask" instruction, then audited
the real codebase and built a genuine vertical slice rather than either
refusing the mismatch or rebuilding from scratch. Preserved everything
from Stage 29 untouched (single-accept flow, cash defaults, date/time
defaults, Available Jobs, Customer Unavailable, messaging) — this stage
only adds new entities and new screens around that existing core.

**New entity: `Merchant`** (`schema.prisma`) — a store client of the
courier business (e.g. "VBR Basics"), distinct from `Business` (the
courier operator itself, still exactly one real row). Each merchant gets
a unique slug, a public order URL
(`{APP_ORIGIN}/order/{slug}`), one or more notification emails, its own
pickup address, and an active/inactive flag. `apps/web/src/pages/merchants.tsx`
is the admin CRUD screen: create, edit, copy the public link, generate a
QR code for it (via `api.qrserver.com`, no key needed), and toggle a
merchant inactive (which 404s its public order page rather than silently
still accepting orders).

**Real relational order items, not a text field.** Added `Product`,
`ProductVariant`, and `JobItem` — a job can now hold N line items, each
with its own product/variant/quantity/price snapshot (`JobItem` freezes
the name/price *at order time*, so a later product-catalog price change
never rewrites history on an already-placed order). `jobs/dto.ts`'s
`jobToDto`/`jobSummaryToDto` now include `items[]`; the rider dashboard
(`rider-dashboard.tsx`) shows the full item list on any job with more
than one item instead of the old single "item summary" line.

**Public order form, no login required**
(`apps/web/src/pages/order.tsx`, `apps/api/src/modules/order.ts`):
`/order` (the courier's own in-house public form) and `/order/:merchantSlug`
(a specific merchant's branded form). Customer name/phone/email, delivery
address via the existing `AddressPicker` (unchanged — reused as-is),
multiple item rows, and date/time fields defaulting to today + 12:00 PM
(same default as Stage 29's staff form). **The server always recomputes
the price** — `PublicOrderBody`'s zod schema has no `fee`/`total` field at
all, so there is nothing for a malicious client to submit; delivery fee
comes from the existing zone/fare engine (`zones.ts`/`quotes.ts`, reused
unmodified) run server-side against the geocoded delivery point, same as
every other order path already in this app. Submitting returns an
order number, a tracking link, and (for an unrecognized phone) a
"claim my account" prompt into the existing Stage 23/25 OTP system —
no new identity system was built; `CustomersService.upsertFromRequest()`
already did phone-normalized find-or-create scoped by business, reused
unchanged.

**Real bug fixed as part of this: phone normalization.** The legacy
`normalizePhone()` in `auth.ts` (used by customers/riders/users — a
*different* function from the Stage-23 libphonenumber-based one used by
the cross-business `CustomerIdentity` system) did not actually unify
"8765551234" / "18765551234" / "+18765551234" into one value, which the
spec calls out explicitly and which matters a lot once random members of
the public are typing their own numbers into a public form. Fixed at the
source; verified safe by running the full 213-test suite (nothing
depends on the old, incorrect output shape) and by hand in the live
demo (876 555 1234 arrived at the API as `+8765551234`, confirmed in the
merchant email and the dispatcher job list for order RM-000071).

**Immediate merchant-owner email** (`apps/api/src/modules/merchant-notify.ts`,
`packages/notifications/src/email.ts`): a full HTML+text order-notification
email fires on every order that has a merchant, non-blocking (order
creation never waits on it or fails because of it), idempotent (a
`Job.merchantNotifiedAt` guard on a conditional `updateMany` — the same
guarded-update pattern this codebase already uses for job-transition
guards — stops a duplicate send, with a `force` option for a genuine
resend). Extended the existing `EmailProvider` abstraction (previously
memory-only, used for verification codes) with `html?` support and a real
`ResendEmailProvider`; `EMAIL_PROVIDER=memory` (the current default) logs
the exact email instead of sending it — verified in this stage's live
test: the full order RM-000071 email (customer, phone, address, map
link, itemized list, subtotal/fee/total, payment method, a link back to
the job) appeared correctly in the server log.

**Cash-by-merchant, not just "rider has $65,000."** `cash-profile.ts`
gained `buildMerchantBreakdown()`: a rider's outstanding cash is now
broken out per merchant ("J$31,000 → VBR Basics, J$19,000 → Merchant B"),
wired into the existing `RiderCashBusinessProfileDto` as a new `byMerchant`
array — the existing single-number total is still there too, this adds
detail rather than replacing it.

**New entity: `Settlement`/`SettlementLine`** — a real ledger for a rider
handing cash to the office, batched per merchant, deliberately kept
**separate** from the pre-existing `Payout`/`PayoutLine` (business paying
the rider their own earnings — a completely different money flow that
this stage does not touch) and from the existing `CodEvent` per-job audit
trail (a `Settlement` batches several already-`handed_in` jobs into one
`approved` transition, reusing the same `CodEvent` mechanism rather than
replacing it — no double-counting, no rewritten history, corrections
would be new entries). `apps/web/src/pages/settlements.tsx` is the admin
screen: outstanding cash grouped by rider-then-merchant, a settle action
per group.

**Smaller integrations threaded through, not bolted on separately**:
merchant selector on the staff `new-job.tsx` order form; merchant
filter dropdown + inline merchant badge on `jobs.tsx`; merchant name
shown next to the business name on both the rider's pre-accept offer
card and post-accept job card (`offers.ts`'s `dto()` and
`rider-dashboard.tsx`); `merchantId` threaded through
`jobs/create.ts`/`repository.ts`/`routes.ts` as a first-class filter
alongside the existing `riderId`/`customerId`/`status` filters, not a
bolted-on special case.

**Live, real end-to-end verification (not just automated tests)**:
rebuilt and redeployed both running demo processes (LAN + Cloudflare
tunnel), created a real merchant ("VBR Basics") via the live API,
placed a real order through the actual public order form running in a
browser against the live tunnel URL, and traced it through every stage
by hand: the order confirmation screen showed job number **RM-000071**;
the dispatcher's `/api/jobs?merchantId=...` showed it with the correct
COD amount (J$4,556 = J$4,500 subtotal + J$56 server-computed delivery
fee — the client never sent a fee at all); the merchant notification
email appeared in the server log with every field correct; a tracking
link was generated and its public `GET /api/tracking/:token` endpoint
returned the job's live status with no authentication required. This is
the single-merchant half of the spec's mandatory end-to-end test
(spec §99/§102) — genuinely exercised, not just asserted.

**Not done in this stage** (see `BLOCKERS.md` for the credential-blocked
items, and the checkpoint's own "not blocked" list for scope
deliberately left for a future stage): polygon-drawn delivery zones
(today: center+radius, unchanged); a separate merchant-staff login/
role; route-optimization UI (the `optimizeStops` function already
exists in `packages/geo`, unused by any screen); CAPTCHA on the public
form; full multi-item entry on the *staff* order form (only a merchant
selector was added there — multi-item entry exists on the new public
`/order` form only). Real email delivery, a production `ronmacraedistributions.com`
deployment, and (optionally) production-grade geocoding all need
credentials only the account owner can supply — the code for all three
is complete and waiting on configuration, not further development.

## Stage 31 — real-deployment hardening + rider/merchant self-service (DONE)

Not a planned stage — a direct response to actually deploying Stage 30
to Render and using it for real, which surfaced several genuine gaps
that automated tests hadn't (and, given the test harness, couldn't
easily) caught. Documented here as one stage since it happened as one
continuous session responding to live findings, commits `43d76c0` through
`b46b393`.

**Real bugs found via live use, not tests, and fixed:**

- `POST /api/users` (staff account creation) created a bare `User` row
  and stopped — no `StaffMembership` — so every account created through
  it (via curl, since no UI called it before this stage) could never
  actually log in: `resolveStaffContext` rejects any non-rider staff
  login with zero active memberships ("no active business membership",
  403). This endpoint had zero test coverage, which is exactly how it
  went unnoticed. Fixed: creating a non-rider staff user now also
  creates an active `StaffMembership` in the creating admin's own
  business. Added `apps/api/test/users.test.ts` — a real create-then-
  login round trip, not just asserting the create call returns 200.
- `bootstrap-prod.ts` (new: a one-time production-database setup
  script, distinct from `seed.ts`'s dev/demo data — creates only the
  real business record and one real admin login) crashed on any re-run
  with `TypeError: the "password" argument must be of type string` —
  an eagerly-evaluated `upsert().create` object called
  `hashPassword(password!)` even on the update branch, where `password`
  was genuinely `null` at runtime (the `!` only silences TypeScript).
  Rewritten with explicit branching: an existing admin's password is
  never touched. Root-caused and fixed based on a very precise bug
  report from the user, who traced the exact evaluation-order bug
  themselves. Added a direct regression test (calling
  `bootstrapProduction` twice against a database the first call already
  bootstrapped).
- The live login page was still showing a hardcoded
  `Demo: admin@ronmacrae.example / admin1234` hint — fine in a local
  demo, actively bad once this became a real public production login
  page. Removed.
- `Business.dispatchNotificationEmail` didn't exist at all: an order
  notified its merchant (if any) but never dispatch itself, and never
  fired for a direct (no-merchant) order at all. Added
  `dispatch-notify.ts` (independent of, and in addition to, the
  existing merchant email — a direct order fires only this one, a
  merchant order fires both), guarded against duplicate sends the same
  way (`Job.dispatchNotifiedAt`), with a manual-resend endpoint.
- No screen anywhere called `POST /api/riders` either — an admin had no
  way to add a working rider account, matching the same "endpoint
  exists, nothing calls it" pattern as the `/api/users` bug above.

**New self-service admin screens** (the actual proximate cause of "why
can't I create a dispatcher/rider" — the backend mostly could, nothing
in the UI ever asked it to):
- `apps/web/src/pages/team.tsx` — create staff logins and riders,
  approve/reject pending rider applications.
- `apps/web/src/pages/settings.tsx` — business contact details and the
  new dispatch-alert email, previously backend-only with no screen.

**Public rider self-signup** (`/join/rider`, linked from the login
page) — genuinely new, not previously scoped for Stage 30. A rider can
apply without any staff involvement: submits details, proves ownership
of their email via a 6-digit code (reusing the existing customer-
account `CustomerEmailCode` verification system rather than building a
parallel one — the table is generic, email+purpose+code, not actually
FK'd to `CustomerAccount` despite its name), then lands as a `pending`
`RiderMembership` an admin/dispatcher must explicitly approve or reject
from the Team screen. Deliberately different from a staff-created
rider (`RidersService.create`), where the creating staff member is
themselves the vouching, so that membership goes active immediately —
nobody vouches for a self-signup, so it always starts pending
regardless of any other status. Email became the rider login
credential going forward (phone remains the identity/coordination key,
per the user's explicit design: "phone number is just how the system
finds out who — login is by email").

**Merchant portal** (`/merchant`) — the largest net-new piece, not in
the original Stage 30 scope: a merchant's own login, deliberately a
separate auth "face" from staff (its own `merchant_portal` JWT type,
same pattern this app already used for the rider bearer face and the
customer dashboard — verified per-route, not through the shared staff
auth hook). An admin grants access from the Merchants screen. Scoped
strictly to that merchant's own data:
- View own orders — a narrower DTO than the staff `JobDto` (no COD
  accountant notes/approvals, no rider payout figures, nothing about
  other customers or merchants).
- Manage own catalog (add/edit/activate/deactivate/delete products) —
  reuses the staff-side validation/DTO shaping (`CreateProduct`,
  `productToDto`, moved to module scope and exported) rather than
  duplicating it; the only real difference is authorization, always the
  merchant on the caller's own token, never a client-supplied one.
- New `MerchantStaff` model (reuses the shared `User` table — email +
  password — rather than a parallel identity table, same pattern as
  `StaffMembership`/`RiderMembership`).

Messaging for the merchant portal (merchant ↔ dispatch/rider about an
order) was scoped for this piece but not yet built — see the newer,
much larger platform-rebuild spec below for where this now sits in
priority.

**Verification**: `npm run typecheck --workspace apps/api --workspace
apps/web` clean throughout every commit in this stage. `apps/api`
vitest grew from 213 (Stage 30's end) to **225/225** across 33 files (12
net new: 2 bootstrap-prod, 2 users, 2 dispatch-notify, 3 rider-signup, 3
merchant-portal — some counts include tests added then extended in a
later commit within this same stage, e.g. rider-signup grew from 2 to 3
as email verification was added). `npm run build --workspace apps/api
--workspace apps/web` clean at every commit. All work was verified live
against the actual Render deployment as it happened (real curl/browser
checks against `https://ronmacrae-dispatch.onrender.com`), not only
against the local test suite — see this stage's own commit messages for
the specific live checks each one passed (e.g. the dispatcher StaffMembership fix
was confirmed by actually creating a dispatcher and logging in as them
against the live API, not just the test suite).

**Real production incidents during this stage, not bugs in the delivered
code**: Render's free-tier database warning (30-day auto-delete) is
still live and still needs the user to upgrade it — flagged repeatedly,
not yet acted on as of this stage. A significant amount of session time
went to an admin-password confusion loop that turned out to be a
genuine environment-configuration mistake, not a code bug: the Render
Start Command was left pointed at a one-time password-reset script
(which exits, unlike the real server) for longer than intended, causing
Render to silently keep serving an older deployment while quietly
regenerating a fresh random password on every restart of the stuck
script — each one invalidating the last before it could be used. No
code fix was needed; the resolution was reverting the Start Command and,
for the final handoff, adding a `RESET_ADMIN_PASSWORD` env-var override
to `reset-admin-password.ts` so a known password can be set and verified
directly (via a live API call) rather than transcribed by hand from a
log viewer.

**Not done in this stage**: messaging for the merchant portal;
rider-to-merchant preferred/dedicated assignment; upgrading the Render
database off its free (30-day-expiring) plan; connecting Twilio for
real SMS/WhatsApp (`NOTIFICATION_PROVIDER` is still `memory`); the
`orders.ronmacraedistributions.com` custom domain was connected during
this stage but is a DNS/Render-dashboard action, not code.

## Stage 32 — one shared login for staff, riders, and merchants (DONE)

A much larger platform-rebuild spec was given after Stage 31 — a full
multi-sided marketplace model (platform admin console, merchant
portals, bearer/logistics-company accounts, ratings, a full messaging
authorization matrix, financial dispute/archival workflow, and more).
That spec is realistically many stages of work on its own; this stage
is the first and most foundational piece of it — everything else in
that spec depends on the login/membership model being correct first.

**What Stage 32 actually is**: the spec's opening requirement, word for
word — "There must be one shared sign-in/sign-up page for everyone. No
separate rider, merchant, logistics, or admin login pages" — and its
explicit demand to "Fix the current broken membership experience...
'This account has no active business membership' issue with actual
code and tests." Both done, for real, with tests proving it, not just
described.

**The actual change**: `resolveStaffContext` (auth.ts) used to throw on
zero active `StaffMembership` rows. It now returns `null` instead, and
`POST /api/auth/login` — the one and only login endpoint, used by
staff, riders, and now merchants alike — falls through to check
`MerchantStaff` access before giving up:
- Staff/rider access resolves → the exact same response shape as
  before (one field added: `workspace: "staff"`), so every existing
  staff/rider login is unchanged — proven by the full pre-existing test
  suite passing with zero modifications needed to any of it.
- No staff/rider access, exactly one merchant workspace → issues a
  `merchant_portal` token directly. A merchant-only account now signs
  in at the identical page and endpoint as everyone else, not a
  separate `/merchant`-only form.
- No staff/rider access, more than one merchant workspace → returns the
  choices, no token yet; re-submitting the same credentials plus the
  chosen id finalizes it (no separate "confirm" endpoint).
- Neither → a specific, honest explanation ("isn't connected to any
  business yet... check for an invite") instead of the old blanket
  error that fired even for a legitimate merchant-only login attempt —
  this was the literal bug: a merchant-only account trying to log in at
  `/merchant` never hit this code path at all before Stage 31's
  merchant-portal work, but the underlying `resolveStaffContext`
  bug would have blocked a merchant account from ever using the *staff*
  login page too, which is exactly the scenario the new spec asks for.

**"Switch workspace"** (spec: "show a clear switch workspace menu
containing only roles/businesses they are authorized to enter"), for
an account with both staff/rider and merchant access on the same
login: `POST /api/auth/switch-to-merchant` and the reverse
`/api/merchant-portal/switch-to-staff`, neither requiring the password
again since the caller already holds a valid session of the other
kind. The reverse direction is deliberately access-token-only (no
refresh cookie) — a documented ~15-minute session rather than
replicating the full refresh/cookie machinery from a merchant-token
context; re-logging in resets it to a full session. `/merchant` no
longer renders its own login form at all — visiting it without a
session redirects to the one shared login page, which routes back
once it resolves to a merchant workspace.

**A real bug found and fixed while building this, not a pre-existing
one**: `POST /api/merchants/:id/staff` (grant merchant portal access,
built in Stage 31) would silently overwrite an *existing* account's
password if that email already had one (as staff, a rider, or another
merchant) — the endpoint always ran `user.upsert()` with a fresh
`passwordHash`, on both the create and update branches. Fixed: an
existing account is only ever linked to the new `MerchantStaff` row,
never touched otherwise; a password is required (and only ever used)
when the call is what actually creates a brand-new account. This also
removed an overly-restrictive rule (also from Stage 31, also this
session's own earlier mistake) that blocked one email from having
portal access at more than one merchant at all — directly in the way
of the "select workspace" flow this stage specifically builds to
support that case.

**Verification**: `npm run typecheck --workspace apps/api --workspace
apps/web` clean. `apps/api` vitest **230/230** across 34 files (5 net
new in `unified-login.test.ts`: merchant-only login through the shared
endpoint, the specific no-access error message, full dual-access
login+both switch directions in one round trip, multi-merchant
select-then-finalize, and a staff-only account correctly refused a
merchant-workspace switch). `npm run build --workspace apps/api
--workspace apps/web` clean. Full e2e suite re-run specifically because
`login.tsx` (used by nearly every spec) changed: **34/35**, the one
failure is `booking.spec.ts`'s address-suggestion flake, already
confirmed earlier in this same session (via `git stash -u` against the
pre-Stage-30 baseline) to be pre-existing and unrelated to any of this
session's work.

**Not done in this stage**: a real secure invite link / password-setup
flow (built next, in Stage 33); pending/active/disabled membership
status beyond the rider-application `pending` state already built in
Stage 31; a platform-admin console; the bearer/logistics-company
account type; ratings; the full messaging authorization matrix;
financial dispute/archival workflow; multi-role switching for more
than two workspace kinds at once.

## Stage 33 — real invite/onboarding flow (DONE)

The other half of the spec's membership-experience fix, immediately
following Stage 32: "if a person is invited/added to a business, they
must get a real usable login/onboarding flow—secure invite link or
password setup, role, pending/active/disabled status, resend invite,
and revoke invite." Additive to the existing "admin sets a password
directly" paths (`POST /api/users`, `/api/merchants/:id/staff`), which
still work unchanged for an admin who'd rather hand someone a password
themselves.

**Design**: a new `Invite` model with deliberately no foreign key to
`User` — the invited person may not have an account at all yet;
accepting the invite is what creates one (or, if that email already
has an account of any kind, attaches the new membership to it instead
— see below). Only `tokenHash` is ever stored, reusing the exact
SHA-256-of-token pattern `jwt.ts` already uses for refresh sessions;
the raw token exists only in the invite email and the accept-invite
URL, never in the database.

- `POST /api/invites/staff` / `/api/invites/merchant/:id` (admin) —
  create and email a real invite link, scoped to the caller's own
  business or one of its own merchants.
- `GET /api/invites` (admin) — every invite for the caller's own
  business and its own merchants, never another business's (tested
  directly: a second business's admin sees zero of the first
  business's invites).
- `POST /api/invites/:id/resend` — issues a fresh token; the old link
  stops working (checked via `/api/invites/check/:token` returning
  404 for the superseded one). `/api/invites/:id/revoke` — permanent;
  both are refused (409) once an invite is no longer `pending`.
- `GET /api/invites/check/:token` / `POST /api/invites/accept`
  (public — the token itself is the credential): an email with no
  existing account sets a password to create one; an email that
  ALREADY has an account (staff, rider, or another merchant) just gets
  the new membership attached, no password touched — the exact same
  fix Stage 32 made to `merchants.ts`'s direct-grant endpoint, applied
  consistently here too.
- `apps/web/src/pages/accept-invite.tsx` — the real page someone lands
  on from the email, showing "set a password" or "just sign in, we
  added this to your existing account" depending on which case applies.
- Team screen gained "Invite staff" (sends the email) alongside the
  existing "Add staff" (admin sets the password directly), plus a
  pending-invites list with Resend/Revoke actions.

**A real test-infrastructure bug found and fixed while building
this** (not a product bug): `buildTestHarness()` writes the resolved
SQLite path into the shared, process-wide `DATABASE_URL` environment
variable (via `getPrisma()`/`applyDatabaseEnv()`), which some part of
the harness's query path re-reads rather than only capturing at Prisma
Client construction time. Calling `buildTestHarness()` a second time
within one test *file* (to simulate "business B" for an isolation
test) silently redirected the *original* harness's later queries at
the second harness's database file — which had by then been deleted by
its own `cleanup()` — producing a confusing "table does not exist"
failure with no connection to the actual change under test. Worked
around locally in `invites.test.ts` by creating a second `Business`
row inside the *same* harness/database instead of a second harness
entirely (achieves the same isolation-test goal without the shared-
global-state hazard); not fixed at the harness level itself, since no
other existing test file does this and the fix scope for a shared test
helper felt disproportionate to one new test needing it.

**Verification**: `npm run typecheck --workspace apps/api --workspace
apps/web` clean. `apps/api` vitest **236/236** across 35 files (6 net
new in `invites.test.ts`). `npm run build --workspace apps/api
--workspace apps/web` clean.

**Not done in this stage**: pending/active/disabled membership status
as a first-class, richer lifecycle (today a membership is simply
active or not — an invite itself has the pending/accepted/revoked/
expired states the spec asks for, but the *membership* it creates on
acceptance does not carry a separate disabled state beyond
StaffMembership/MerchantStaff's existing `active` boolean); a
platform-admin console (built next, in Stage 34); the
bearer/logistics-company account type; ratings; the full messaging
authorization matrix; financial dispute/archival workflow.

## Stage 34 — Platform Admin console (DONE)

Fills a gap `owner.ts` itself has flagged as open since Stage 23: "this
is not a general owner console (business creation/listing and rider
platform-approval screens remain a documented, open gap)." Reuses the
existing `platformRole: "owner"` concept — a staff/rider login that
also carries this flag — rather than inventing a new auth face; an
owner's existing session already works against every route this stage
adds.

**Scope, stated honestly**: this covers real data this app actually
has — business/merchant/rider/staff records, real job-status counts,
real cash figures via the existing `cash-profile.ts` service. It does
NOT cover ratings, admin-to-anyone messaging, or per-person dispute
rollups, because none of those systems exist in this app yet — the
rider detail view says `ratings: not built yet` outright rather than
fabricating a section for something that isn't real.

**What was built**:
- `GET`/`PATCH /api/platform/businesses` — list (with merchant/staff/
  rider/job counts), disable/reactivate.
- `GET`/`PATCH /api/platform/merchants` — list across every business
  (with the business name attached — this is the one place in the app
  that shows merchants cross-business at all), disable/reactivate.
- `GET`/`PATCH /api/platform/riders` — the spec's explicit, named ask:
  "Platform Admin controls whether a rider is freelancer/platform-
  approved... or disabled/blocked." A list plus a detail view (every
  business membership, job counts by status, a cash profile per
  business) and control over both `platformStatus`
  (pending/approved/suspended) and the account's own `active` flag.
- `GET`/`PATCH /api/platform/staff` — every staff and merchant-staff
  login on the whole platform, not just one business's own Team
  screen; disable/reactivate, with a hard server-side guard against an
  owner disabling their own account by mistake.
- `GET /api/platform/audit` — the platform-wide audit trail. The
  existing `GET /api/audit` (Stage 23's own business-scoping fix)
  stays exactly as it was for ordinary staff — this is a new, separate,
  owner-only view, not a change to that one's scoping.
- `apps/web/src/pages/platform-admin.tsx` (`/platform-admin`) — five
  tabs matching the above; both the route and its nav-bar entry are
  owner-only (a non-owner never even sees the tab exists, not just
  blocked if they guess the URL).

**Two real gaps found and fixed while building this, not pre-existing
bugs from before this session**:
- `UserDto` never exposed `platformRole` at all — the frontend had no
  way to know whether the logged-in user even qualified to see this
  console, regardless of what the backend allowed. Added it to the
  type and to `toUserDto()`.
- The real production admin account has never had `platformRole:
  "owner"` set — `bootstrap-prod.ts` (Stage 30) only ever created an
  ordinary `admin` role with a `StaffMembership`, never platform-wide
  authority. Without fixing this, the account owner themselves would
  be refused by `ctx.requireOwner` on every route this stage adds.
  Added `grant-platform-owner.ts`, a one-time, idempotent script (set
  `GRANT_OWNER_EMAIL`, run once) — the same safe pattern this session
  already established for `bootstrap-prod.ts`/`reset-admin-password.ts`.

**A real latent bug found and fixed while writing this stage's own
tests**: `RidersService.create()` (the staff-facing "add a rider"
endpoint, used since Stage 20) wrapped its rider-plus-membership
creation in a `$transaction` — the exact same hazard already found and
fixed in `selfSignup()` during Stage 31 (the test harness's own
rider-creation hook can't reliably see writes made inside an open
transaction from a separate connection). This had no test coverage
until this stage's own tests needed to create a rider via the real
`POST /api/riders` endpoint for the first time. Fixed with the same
pattern: an idempotent `riderMembership.upsert()` outside the
transaction, instead of an insert inside one.

**Verification**: `npm run typecheck --workspace apps/api --workspace
apps/web` clean. `apps/api` vitest **243/243** across 36 files (7 net
new in `platform-admin.test.ts`: ordinary staff refused every platform
route, an owner seeing every business/merchant not just their own,
rider platform-status approve/suspend with a real detail view, staff
disable with a hard self-disable guard, and every mutating action
showing up in the platform-wide audit log). `npm run build --workspace
apps/api --workspace apps/web` clean. Full e2e suite re-run given how
broadly `toUserDto`/auth were touched: **34/35**, the one failure is
the same already-confirmed-unrelated `booking.spec.ts` flake.

**Not done in this stage**: ratings; admin-to-anyone messaging; per-
person shortage/dispute rollups; the bearer/logistics-company account
type (so no fleet-level view yet — this stage's businesses/merchants/
riders/staff tabs are the closest analog today); a richer disabled-vs-
archived distinction beyond the existing `active` boolean on each
model; approve/reject for pending StaffMembership or MerchantStaff
grants specifically (those go active immediately today, same as
before this stage — only rider `platformStatus` has an approve/suspend
control, matching the one place the spec names explicitly).

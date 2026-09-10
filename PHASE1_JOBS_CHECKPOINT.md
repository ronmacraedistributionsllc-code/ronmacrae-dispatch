# Phase 1 — Jobs Backend Checkpoint

**Status: PASS** — the Phase 1 jobs backend is verified. Its module files type-check clean
and its tests pass. Frontend work has **not** been started.

## Scope

The jobs backend is `apps/api/src/modules/jobs/**` plus the job-queue abstraction
`apps/api/src/queue/**`. Verification covered only those jobs-related files; the rest of
the repository was not inspected.

- `apps/api/src/modules/jobs/` — `index`, `routes`, `create`, `assign`, `transition`,
  `payment`, `history`, `proofs`, `repository`, `dto`
- `apps/api/src/queue/index.ts` — `MemoryQueue` / `BullQueue` job queue
- Jobs tests — `apps/api/test/queue.test.ts` (the jobs/queue unit test)

## Git state

`ronmacrae-dispatch` is **not** a git repository (no `.git`), so `git status` / `git diff`
do not apply and were not run.

## Commands run and results

Working directory for all commands: `apps/api`

### 1. TypeScript check — `npm run typecheck` (`tsc -p tsconfig.json --noEmit`)

- **Before fix:** FAILED — 5 errors:
  - `src/modules/jobs/routes.ts(142,84)` — `string | null` not assignable to `string | undefined` (cancel note)
  - `src/modules/jobs/routes.ts(155,60)` — `CollectInput.note` `string | null` vs `string | undefined`
  - `src/server.ts(23,31)` — cannot find module `./modules/requests.js`
  - `src/server.ts(24,30)` — cannot find module `./modules/bearer.js`
  - `src/server.ts(25,27)` — cannot find module `./modules/geo.js`
- **After fix:** `tsc` reports **3 errors total: 0 in `modules/jobs/**`, 0 in `queue/**`**.
  All 3 remaining errors are in `src/server.ts` (see Out-of-scope below). The jobs
  backend itself is type-clean.

### 2. Unit tests — `npm run test:unit` (`vitest run`)

- **PASS** — 5 test files, **27/27 tests passed**:
  - `queue.test.ts` (jobs/queue) — 3 passed
  - `config.test.ts` — 10 passed
  - `password.test.ts` — 5 passed
  - `quotes.test.ts` — 5 passed
  - `totp.test.ts` — 4 passed

## Fixes applied (2 small patches, jobs module only)

Both were `null` vs `undefined` mismatches at call sites in `routes.ts`. The note fields
already null-coalesce at runtime and the codebase convention (`TransitionInput.note?:
string | null`) allows `null`, so the callee param types were widened to match — no change
to `routes.ts` and no behavior change.

1. `src/modules/jobs/transition.ts:261` — `cancelJob(..., note?: string)` → `note?: string | null`
2. `src/modules/jobs/payment.ts:56` — `CollectInput.note?: string` → `note?: string | null`

## Out of scope (not fixed)

`src/server.ts` imports and registers three modules that do not exist as files:
`modules/requests.js`, `modules/bearer.js` (the rider/frontend-facing module), and
`modules/geo.js`. These are **not** part of the jobs backend. Creating them would add new
features / start frontend work, which is out of scope for this checkpoint. Left as-is;
they are the only remaining `tsc` errors.

## Re-verify

```bash
cd apps/api
npm run typecheck   # expect: only the 3 server.ts missing-module errors; none in modules/jobs or queue
npm run test:unit   # expect: 27/27 pass (queue.test.ts 3/3)
```

---

# Booking-forms verification (resumed, 2026-09-10)

**Status: PASS** — the auth refresh-session root cause is fixed (below), and the
remaining booking e2e blocker (empty-body tracking-link request) is fixed in the
"Tracking-link e2e fix" section at the end of this file. All unit/build/e2e gates
pass.

## Auth refresh-session repair (root cause)

`apps/api/src/modules/auth.ts`, `POST /api/auth/refresh` rotation:

- **Before:** `ctx.prisma.session.deleteMany({ where: { userId: user.id } })` — every
  refresh deleted **all** of the user's sessions, so refreshing one token killed the
  user's other active sessions (other devices/tabs).
- **After:** `ctx.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } })`
  — rotates only the presented session (`Session.tokenHash` is `@unique`), then
  `issueTokenPair` creates the new session row. This matches the documented client
  contract (`apps/web/src/lib/api.ts` doc: "deleting the presented token's row") and the
  logout route's existing single-session pattern.
- Also removed 6 `[DBG-*]` `console.log` instrumentation lines the interrupted session
  had left in `auth.ts`; one of them (`req.body?.identifier` in login) broke `tsc`.
  Deliberate invalidate-all paths were **not** touched: logout (all devices), password
  change (`auth.ts`), user deactivation (`users.ts:67`), rider update (`riders.ts:174`).
- Note: no route-level multi-session unit test exists; the fix is verified by code review
  + typecheck + the full unit suites. (A refresh-route multi-session test would be new
  test code — left for a follow-up.)

## Commands run and results

Working directory for all commands: `ronmacrae-dispatch` (repo root)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run test:unit --workspace @ronmacrae/api` (auth tests: `password.test.ts` incl. refresh-token hashing, `totp.test.ts`) | **PASS** — 5 files, 27/27 (totp 4, config 10, quotes 5, queue 3, password 5) |
| 2 | `npm run test:unit --workspace @ronmacrae/web` (auth client tests: `test/api.test.ts` — bearer attach, refresh-on-401 + retry, ApiError) | **PASS** — 1 file, 3/3 |
| 3 | `npm run typecheck --workspace @ronmacrae/api` | **PASS** — 0 errors (was 1 error pre-cleanup; Phase 2 baseline restored) |
| 4 | `npm run build --workspace @ronmacrae/web` | **PASS** — `dist/assets/index-B5VjMJdl.js` 257.48 kB (gzip 77.44 kB), CSS 16.31 kB, PWA `sw.js` generated, 7 precache entries |
| 5 | `npx playwright test specs/booking.spec.ts` (`e2e/`, boots seeded API on :3000, fresh dev DB) | **1 FAILED / 2 PASSED** — see blocker |

E2e detail (spec `e2e/specs/booking.spec.ts`, chromium):

- ✘ `staff books a delivery from the New Order form and gets a tracking link` —
  test timeout 45 s; job **was** booked (success card "Booked — RM-000021"), but the
  card shows the fallback: *"The job is booked, but the tracking link could not be
  created (Body cannot be empty when content-type is set to 'application/json').
  Generate it from the Jobs queue."* — spec then times out waiting for the `/track/`
  link.
- ✓ `customer books a delivery from the public form and gets a tracking link` (194 ms)
- ✓ `public delivery-request endpoint returns a job number and tracking link` (19 ms)

## Remaining blocker (fixed — see "Tracking-link e2e fix" below)

The web client posts `POST /api/jobs/:id/tracking-link` with an **empty body** while
unconditionally sending `content-type: application/json`
(`apps/web/src/lib/api.ts:60` sets the header on every `apiFetch` call;
`apps/web/src/pages/new-job.tsx:162` sends no body). Fastify 5.12.3 rejects this with
500 `FST_ERR_CTP_EMPTY_JSON_BODY` ("Body cannot be empty when content-type is set to
'application/json'"). The tracking-link create then falls into the best-effort
`catch` in `new-job.tsx`, so no link renders and the e2e times out.

This is independent of the refresh-session fix: the 15-min access token cannot expire
within the 45 s test window, so no refresh occurs in the failing test; login, the job
create, and session handling all worked. The identical error was captured in the
interrupted run's `test-results/…/error-context.md` (job RM-000018) before the fix.
Fixing it requires a web-client (or API route) change — a working-module edit outside
the scoped auth root-cause repair — so it is reported as the blocker, not fixed.

## Environment notes

- The interrupted session had left a stale `tsx watch src/main.ts` dev server on
  :3000; it was killed before the e2e so Playwright's `webServer` boots the fixed code
  (`reuseExistingServer: !CI` would otherwise have tested pre-fix code). Port 3000 is
  free after the run.
- `apps/api/data/dev.db` accumulated the e2e jobs (RM-000021); disposable, as before.

---

# Tracking-link e2e fix (resumed, 2026-09-10)

**Status: PASS** — the remaining booking end-to-end failure is fixed. All gates pass
(e2e, API unit, API typecheck, web build, web unit). No authentication changes, no
new features.

## Fix (one patch, web client only)

`apps/web/src/lib/api.ts` (`apiFetch`) — `"content-type": "application/json"` was set
unconditionally on **every** request, including bodyless ones such as
`POST /api/jobs/:id/tracking-link` (`apps/web/src/pages/new-job.tsx:162` sends no
body). Fastify 5.12.3 rejects an empty-body request carrying that header with 500
`FST_ERR_CTP_EMPTY_JSON_BODY` ("Body cannot be empty when content-type is set to
'application/json'"); the best-effort `catch` in `new-job.tsx` then hid it, the card
fell back to the "Generate it from the Jobs queue" message, and the spec timed out
waiting for the `/track/` link.

- **Before:** `headers: { "content-type": "application/json", ...auth, ...init.headers }`
  on every call.
- **After:** the header is emitted only when a body is actually present —
  `...(init.body != null && init.body !== "" ? { "content-type": "application/json" } : {})`.
  Requests with a body are unchanged (and caller-supplied headers still win, as
  `...init.headers` remains last in the spread). The API route was not touched; it
  never reads a body.

One operational note: the Playwright `webServer` (e2e) serves the **prebuilt**
`apps/web/dist` via the `WEB_DIST` env var, so a source-only fix is not enough — the
web must be rebuilt before the booking spec runs. The first e2e run after the source
fix (against the stale dist) still failed 1/2; after `npm run build --workspace
@ronmacrae/web` the spec passed 3/3.

## Commands run and results (2026-09-10)

Working directory: `ronmacrae-dispatch` (repo root); e2e command runs from `e2e/`

| # | Command | Result |
| --- | --- | --- |
| 1 | `npx playwright test specs/booking.spec.ts` (against **stale** dist) | 1 FAILED / 2 PASSED — staff test still timed out at 45 s (dist predated the fix) |
| 2 | `npm run build --workspace @ronmacrae/web` | **PASS** — `dist/assets/index-CbMirM2w.js` 257.51 kB (gzip 77.45 kB), `dist/assets/index-CwIKeoSe.css` 16.31 kB (gzip 3.84 kB), PWA `dist/sw.js` + `dist/workbox-9c191d2f.js` generated, 7 precache entries (268.27 KiB) |
| 3 | `npx playwright test specs/booking.spec.ts` (rebuilt dist, fresh seeded API on :3000) | **3 PASSED / 0 FAILED** — `staff books a delivery from the New Order form and gets a tracking link` **495 ms** (was: 45 s timeout), `customer books a delivery from the public form…` 183 ms, `public delivery-request endpoint…` 12 ms; total 5.9 s |
| 4 | `npm run typecheck --workspace @ronmacrae/api` (`tsc -p tsconfig.json --noEmit`) | **PASS** — 0 errors |
| 5 | `npm run test:unit --workspace @ronmacrae/api` | **PASS** — 5 files, **27/27** (config 10, queue 3, quotes 5, password 5, totp 4) |
| 6 | `npm run test:unit --workspace @ronmacrae/web` | **PASS** — 1 file, **3/3** (`test/api.test.ts`: bearer attach, 401 refresh + retry, ApiError) |

The staff booking test now renders the "Customer tracking link" card and the spec
reads a real `/track/<token>` href (the earlier amber "could not be created" fallback
no longer appears). Port 3000 is free after the run (Playwright tears down its
webServer). `apps/api/data/dev.db` accumulated the new e2e jobs; disposable, as before.

## Re-verify

```bash
cd ronmacrae-dispatch
npm run build --workspace @ronmacrae/web            # the e2e serves this dist via WEB_DIST
cd e2e && npx playwright test specs/booking.spec.ts # expect: 3/3 pass
```

---

# Phase 1 — Mobile-first rider dashboard (completed, 2026-09-10)

**Status: PASS** — the logged-in rider dashboard is complete. It uses rider-scoped
API routes, so a rider can retrieve only jobs assigned to their own rider record.
No GPS functionality was added.

## Delivered

- `apps/web/src/pages/rider-dashboard.tsx` — responsive delivery cards with customer phone,
  pickup/destination/landmark, products/colour/size/quantity, order value, delivery fee,
  payment method, COD amount, requested time, priority and instructions. Includes every
  valid rider action: Accept, Heading to Pickup, Arrived at Pickup, Collected, In Transit,
  Arrived at Destination, Delivered, Not Answering, Customer Changed Location, Failed and
  Returned.
- `apps/web/src/pages/dashboard.tsx` — routes riders to the rider dashboard and leaves the
  dispatcher dashboard intact.
- `apps/web/src/lib/auth.tsx` — loads the complete rider DTO after login, so availability
  and rider-scoped data are available immediately.
- `apps/web/src/lib/api.ts` — accepts both existing API-base-relative paths and absolute
  shared contract paths without producing `/api/api/...`.
- `apps/api/src/modules/bearer.ts` and `apps/api/src/server.ts` — register the predeclared
  bearer routes. `GET /api/bearer/jobs` is constrained to the JWT rider ID; accept,
  transition and stage actions reuse the existing jobs domain functions.
- `apps/api/src/modules/jobs/transition.ts` and `apps/api/src/modules/jobs/index.ts` — add
  an event-backed rider-stage update for heading/arrival at pickup. Delivery through the
  bearer route requires the matching delivery PIN server-side. Optional proof/action notes
  are persisted through the existing transition event `note` contract; no new proof schema
  was invented.
- `packages/contracts/src/routes.ts` — adds the bearer stage route alongside the existing
  bearer route contracts.
- `e2e/specs/rider-dashboard.spec.ts` — rider e2e covers assigned-only details, accept,
  both pickup stage events, the remaining rider transitions and PIN-protected delivery.
- `e2e/specs/jobs.spec.ts` — selects the seeded rider by stable option position rather than
  its availability label, which can legitimately be `on_job` when the rider e2e runs in a
  parallel browser worker.

## Verification

Working directory: `ronmacrae-dispatch` (e2e commands run from `e2e/`).

| Command | Result |
| --- | --- |
| `npm run typecheck --workspace @ronmacrae/api` | **PASS** — 0 errors |
| `npm run typecheck --workspace @ronmacrae/web` | **PASS** — 0 errors |
| `npm run test:unit --workspace @ronmacrae/api` | **PASS** — 5 files, 27/27 tests |
| `npm run test:unit --workspace @ronmacrae/web` | **PASS** — 1 file, 3/3 tests |
| `npm run build --workspace @ronmacrae/web` | **PASS** — production PWA build; `index-BOGcMeYT.js` 265.16 kB (gzip 79.20 kB), CSS 16.67 kB (gzip 3.92 kB), 7 precache entries |
| `CI=1 npx playwright test --reporter=list` | **PASS** — 10/10 tests in 20.7 s (booking 3, smoke 4, dispatcher jobs 1, rider dashboard 1, refresh debug 1) |

The e2e command uses `CI=1` to force a clean seeded local API server instead of reusing a
possible pre-existing server. It leaves the disposable `apps/api/data/dev.db` populated
with test jobs.

## Preview and demo rider

```bash
cd ronmacrae-dispatch
npm run build --workspace @ronmacrae/web
WEB_DIST="$PWD/apps/web/dist" DEV_DB=1 QUEUE_DRIVER=memory NOTIFICATION_PROVIDER=memory npm run dev --workspace @ronmacrae/api
# Open http://127.0.0.1:3000
```

Demo rider: **Kei Bearer** — phone `+8765550001`, password `rider1234`.

## Unfinished Phase 1 requirement

None. GPS remains intentionally unimplemented, as requested; the dashboard exposes only
the existing online/offline availability capability.

---

# Web delivery workflow handoff — partial Stage 1 (2026-09-10)

**Status: PAUSED AT USER REQUEST — not verified; do not treat Stage 1 as complete.**

## Completed changes in this partial edit

- Added the schema draft for `OfferStatus` and `JobOffer` in
  `apps/api/prisma/schema.prisma`, with job/rider relations and indexes.
- Added `JobOfferDto` and offer/bearer-offer route constants in
  `packages/contracts/src/types.ts` and `packages/contracts/src/routes.ts`.
- Added and registered the draft `apps/api/src/modules/offers.ts` offer routes:
  broadcast, list, withdraw, rebroadcast, rider list, decline and atomic rider accept.
  Its accept transaction conditionally claims an unassigned `new` job and withdraws the
  competing open offers, so it is intended to prevent two riders from winning.
- Registered `offerRoutes` from `apps/api/src/server.ts`.

## Important partial-work limitations

- This implementation has **not** been Prisma-generated, typechecked successfully, tested,
  or exposed in the dispatcher/rider UI.
- Direct dispatcher assignment has **not yet** been amended to withdraw open offers in the
  same conditional transaction. That is required before claiming concurrent manual assignment
  and offer acceptance are safe.
- The rebroadcast implementation does not yet re-check rider capacity after selecting available
  riders. The first broadcast does; make both paths share one eligibility helper.
- No offer alert UI, unread state, push subscription, service-worker changes, GPS/map UI,
  customer tracking hardening, or new e2e tests were started. Stages 2–4 remain untouched.
- Offer DTOs intentionally omit PIN, customer phone/name, and full street-level customer data;
  this privacy behavior is draft code and still requires review/tests.

## Tests actually run after the partial edit

| Command | Exact result |
| --- | --- |
| `npm run typecheck --workspace @ronmacrae/api` | **FAILED** — 11 TypeScript errors, all `Property 'jobOffer' does not exist on type PrismaClient` in `src/modules/offers.ts`. This is because the generated Prisma client predates the new schema model. No unit, browser, or build command was run after this partial edit. |

## Exact next steps for the local builder

1. From `apps/api`, run `npm run db:prepare` (with the intended `DEV_DB`/`DATABASE_URL`). This regenerates Prisma from `schema.prisma` and applies the additive `JobOffer` table. Back up a non-disposable database first; the existing e2e/dev sqlite database is disposable.
2. Run `npm run typecheck --workspace @ronmacrae/api`; fix any remaining `offers.ts` typing errors.
3. Refactor `offers.ts` to share one eligibility-and-create helper for broadcast/rebroadcast,
   including active-job capacity checks.
4. Amend `apps/api/src/modules/jobs/assign.ts` so manual assignment conditionally claims the
   same job state and withdraws open offers in its transaction. Add tests for simultaneous
   manual assignment and two rider offer-accept requests.
5. Add focused offer UI only after backend tests pass; preserve the existing rider dashboard
   and do not expose PIN/customer personal data in offer cards.
6. Only then resume Stage 2 (alerts), Stage 3 (foreground browser GPS/maps), and Stage 4.

No map provider was added, no credentials/billing action was taken, and no notification or
location behavior was claimed as delivered in this partial state.

---

# Delivery-offers backend draft repair (resumed, 2026-09-10)

**Status: PASS for this scoped repair — the draft is now Prisma-generated, type-clean,
and unit-green, but it is still a DRAFT.** Do not claim Stage 1 complete: no offer
tests, no offer UI, no alerts, and `assign.ts` does not yet withdraw open offers. Of the
"Exact next steps for the local builder" above, steps 1–2 are done; steps 3–6 remain.
The "Important partial-work limitations" above still apply except the first bullet
(generated + typecheck now done).

## Safety (before the push)

- Copied `apps/api/data/dev.db` to `apps/api/data/dev.db.bak-offers` (434,176 bytes).
- Snapshotted table names/row counts to `/tmp/tables_before.txt` and
  `/tmp/counts_before.txt` (23 tables, no `JobOffer`).

## Commands run and results

| # | Command (working dir) | Result |
| --- | --- | --- |
| 1 | `DEV_DB=1 npm run db:prepare` (`apps/api`) | **PASS** — materialized `prisma/schema.generated.prisma` (sqlite provider), generated Prisma Client v6.19.3, `prisma db push` reported database in sync, no destructive-diff / data-loss warning |
| 2 | `npm run typecheck --workspace @ronmacrae/api` (repo root) | **PASS** — 0 errors. The 11 stale-client `Property 'jobOffer' does not exist on type PrismaClient` errors in `src/modules/offers.ts` disappeared after client regeneration; **no `offers.ts` code edits were needed** |
| 3 | `npm run test:unit --workspace @ronmacrae/api` (repo root) | **PASS** — 5 files, **27/27** (config 10, queue 3, quotes 5, password 5, totp 4) |

## Additive-change proof (no data loss)

- Table count went 23 → 24; the **only** schema diff is the new `JobOffer` table.
- Row counts after the push are identical to before, plus the new empty table:
  `AuditLog=196`, `ConsentRecord=0`, `Customer=32`, `ExternalOrder=0`, `FareRule=1`,
  `Job=55`, `JobEvent=101`, `JobOffer=0`, `OutboxMessage=0`, `Payout=0`, `PayoutLine=0`,
  `Proof=0`, `ReconDaily=0`, `Rider=1`, `RiderAssignment=12`, `RiderLocation=0`,
  `Route=0`, `RouteStop=0`, `Session=64`, `Setting=1`, `SosAlert=0`, `TrackingLink=24`,
  `User=5`, `Zone=3` (see `/tmp/counts_before.txt` / `/tmp/counts_after.txt`).
- The `JobOffer` table: `id`, `jobId`, `riderId`, `status` (default `"open"`),
  `expiresAt`, `note`, `createdAt`, `updatedAt`; FKs to `Job(id)` and `Rider(id)` with
  cascade behavior. `prisma/schema.generated.prisma` now has 24 models
  (`model JobOffer {` at line 288).
- `apps/api/src/server.ts:22` registers `offerRoutes`; `offers.ts` exposes broadcast,
  list, withdraw and rebroadcast (plus the rider list/decline/accept routes).

## Still open (the remaining checkpoint steps 3–6)

1. Refactor `offers.ts` so broadcast/rebroadcast share one eligibility-and-create helper
   (rebroadcast must re-check rider capacity).
2. Amend `apps/api/src/modules/jobs/assign.ts` so manual assignment conditionally claims
   the job and withdraws open offers in the same transaction; add tests for simultaneous
   manual assignment and two rider offer-accept requests.
3. Add focused offer unit tests (none exist yet).
4. Only then add offer UI (preserving the existing rider dashboard; no PIN/customer
   personal data in offer cards), then resume Stage 2 (alerts), Stage 3 (foreground
   browser GPS/maps) and Stage 4.

No map provider, credentials/billing action, notification, or location behavior was added
in this repair.

## Re-verify

```bash
cd apps/api
DEV_DB=1 npm run db:prepare
npm run typecheck
npm run test:unit
```

Expected: push in sync (no data-loss warning), 0 typecheck errors, 27/27 unit tests.

---

# Delivery-offers Stage 1/2 — atomic accept/assign + concurrency/auth tests (Claude Code, 2026-09-10)

**Status: PASS.** Resumed from an interrupted OpenCode session with no git history.
See `WORK_IN_PROGRESS.md` for the full recovery narrative, the latent
`effectiveDatabaseUrl` bug found (documented, not fixed — out of scope), and the
`JobOfferDto` gap to resolve before Stage 3 (UI). Short version here.

## Verified before touching anything

Checked the actual code, not the interrupted session's summary: `apps/api/src/modules/jobs/assign.ts`
already withdrew open offers atomically inside its conditional-claim transaction, and
`apps/api/src/modules/offers.ts`'s accept route was already an atomic conditional
claim (`status: "new", riderId: null` gate) that withdraws competing offers. The one
real gap: `rebroadcast` never re-checked rider daily capacity the way `broadcast` did.

## Fix (offers.ts)

Extracted a shared `eligibleRiders()` helper (active + daily-capacity check), used by
both `broadcast` and `rebroadcast`. Wrapped rebroadcast's offer creation in a
`$transaction` (broadcast already had one). Added a `job.state` realtime broadcast on
offer-accept, matching `assignJob`'s existing pattern.

## New tests

`apps/api/test/offers.test.ts` (8 tests) against a real Fastify app + a real,
disposable per-run sqlite db (`apps/api/test/helpers/test-app.ts` — not mocks):

1. Two riders racing to accept the same offer set — exactly one wins (200/409), one
   `RiderAssignment` row.
2. A rider's accept racing a dispatcher's direct assignment on the same job — exactly
   one wins.
3. A rider at daily capacity is excluded from both broadcast and rebroadcast
   (regression test for the fix above).
4. Expired offers can't be accepted and are lazily swept to `status: "expired"`.
5. Withdrawn offers can't be accepted.
6. Authorization: unauthenticated → 401; rider-role broadcast → 403; rider accepting
   another rider's offer → 409, offer left untouched.

## Commands run and results (2026-09-10)

Working directory: `ronmacrae-dispatch` (repo root)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck --workspace @ronmacrae/api` | **PASS** — 0 errors |
| 2 | `npm run test:unit --workspace @ronmacrae/api` | **PASS** — 6 files, **35/35** (27 pre-existing + 8 new) |
| 3 | `npm run typecheck --workspace @ronmacrae/web` | **PASS** — 0 errors (unchanged) |
| 4 | `npm run test:unit --workspace @ronmacrae/web` | **PASS** — 1 file, 3/3 (unchanged) |
| 5 | `npm run build --workspace @ronmacrae/web` | **PASS** — 265.16 kB JS (gzip 79.20 kB), PWA generated |

E2e was **not** re-run (no web/UI changes this session) — re-verify before trusting it:
`cd e2e && CI=1 npx playwright test`.

`apps/api/data/dev.db` and `apps/api/data/dev.db.bak-offers` are untouched by this
session (byte-identical timestamps to before). The offers tests use a disposable
`apps/api/data/test-offers.db`, deleted by the test itself after each run.

## Still open (Stages 3–6)

Dispatcher offer UI + rider Accept/Decline cards, in-app alerts + opt-in browser
push, foreground GPS + dispatcher maps + secure customer tracking, and the final
full-workflow gate pass. See `WORK_IN_PROGRESS.md` for the exact next steps and the
`JobOfferDto` decision Stage 3 needs first.

## Re-verify

```bash
cd apps/api && npx vitest run test/offers.test.ts   # expect 8/8
npm run typecheck --workspace @ronmacrae/api        # expect 0 errors
npm run test:unit --workspace @ronmacrae/api        # expect 35/35
```

---

# Delivery-offers Stage 3 — dispatcher/rider offers UI + e2e (Claude Code, 2026-09-10)

**Status: PASS.** See `WORK_IN_PROGRESS.md` for full detail. Short version here.

## What was built

- Closed the `JobOfferDto` gap noted at the end of Stage 2: added optional
  `riderId`/`riderName`, populated only on staff-facing offer routes
  (`apps/api/src/modules/offers.ts`, a `{ includeRider: true }` flag on the existing
  `dto()` helper). Contracts package rebuilt.
- Dispatcher UI: an "Offers" toggle per unassigned job row on
  `apps/web/src/pages/jobs.tsx` opens `apps/web/src/components/job-offers-panel.tsx`
  (new) — broadcast/rebroadcast (with an expiry-minutes input) and a live per-rider
  offer list with a Withdraw button on open offers.
- Rider UI: a polled "Job offers" section on `apps/web/src/pages/rider-dashboard.tsx`
  with Accept/Decline cards (pickup/destination, item, earnings/fee/COD, expiry
  countdown).
- New e2e spec `e2e/specs/offers.spec.ts` (2 tests): full broadcast → accept flow
  across two real browser contexts (dispatcher + a dedicated fresh rider, not the
  shared seeded one, to stay immune to other specs' parallel state), and a
  withdraw-hides-the-offer check. Two real bugs were found and fixed getting it
  green — a login/navigate race and an ambiguous-locator issue from accumulated
  same-named test riders in the disposable dev db (fixed with `data-testid`s scoped
  by row/rider id, not display text — both are test-file changes, not app code bugs).

Realtime push was deliberately **not** used here — the web app has no websocket
client yet (Stage 4's job). The offers UI polls (8-10s) as an interim.

## Commands run and results (2026-09-10)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run build --workspace @ronmacrae/contracts` | **PASS** |
| 2 | `npm run typecheck --workspace @ronmacrae/api` | **PASS** — 0 errors |
| 3 | `npm run test:unit --workspace @ronmacrae/api` | **PASS** — 35/35 |
| 4 | `npm run typecheck --workspace @ronmacrae/web` | **PASS** — 0 errors |
| 5 | `npm run test:unit --workspace @ronmacrae/web` | **PASS** — 3/3 |
| 6 | `npm run build --workspace @ronmacrae/web` | **PASS** — 271.28 kB JS (gzip 80.84 kB) |
| 7 | `cd e2e && CI=1 npx playwright test` | **PASS** — **12/12** (10 pre-existing + 2 new) |
| 8 | `npm run lint` (repo root) | 8 pre-existing errors, all in files untouched this session (unused imports in `jobs/proofs.ts`, `jobs/repository.ts`, `jobs/transition.ts`, `settings.ts`, `tracking.ts`) — not a regression, not previously a green gate |

## Still open (Stages 4-6)

In-app live alerts (needs a frontend websocket client — none exists yet) + opt-in
browser push, foreground GPS + dispatcher maps + secure customer tracking, and the
final full-workflow gate pass. See `WORK_IN_PROGRESS.md` for the concrete next steps.

## Re-verify

```bash
npm run build --workspace @ronmacrae/contracts
npm run typecheck --workspace @ronmacrae/api && npm run test:unit --workspace @ronmacrae/api
npm run typecheck --workspace @ronmacrae/web && npm run test:unit --workspace @ronmacrae/web && npm run build --workspace @ronmacrae/web
cd e2e && CI=1 npx playwright test   # expect 12/12
```

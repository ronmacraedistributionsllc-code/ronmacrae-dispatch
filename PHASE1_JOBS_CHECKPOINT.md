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

---

# Delivery-offers Stage 4 — realtime in-app alerts + opt-in browser push (Claude Code, 2026-09-10)

**Status: PASS.** Full detail in `WORK_IN_PROGRESS.md`. Short version here.

## What was built

- **Realtime client** (new `apps/web/src/lib/realtime.tsx`, mounted in `app.tsx`):
  the web app had no websocket client before this. Connects to the existing hub
  (`apps/api/src/rt/hub.ts`), reconnects with backoff, refreshes the access token
  on a stale-token close. `packages/contracts/src/realtime.ts` gained `"offer"` in
  the formal `RealtimeMessage` union (already sent at runtime, wasn't typed).
- **In-app alerts** (new `apps/web/src/components/alerts-toaster.tsx`): a global
  toast stack — new-offer toasts for riders, assignment/SOS toasts for staff.
- Wired into the Stage 3 UI: the dispatcher offers panel and rider dashboard both
  subscribe to realtime messages and invalidate immediately, with polling relaxed
  to a 20s fallback (was 8-10s). `offers.ts` now also broadcasts new offers to the
  dispatch room (staff-shaped dto) so the dispatcher panel can go live too.
- **Opt-in Web Push (VAPID)**: new `PushSubscription` Prisma model (additive
  migration, `dev.db` backed up first — see `WORK_IN_PROGRESS.md` for the
  before/after table diff proof), new `apps/api/src/modules/push.ts`
  (subscribe/unsubscribe/public-key routes + best-effort send, wired into offer
  broadcast so every offered rider gets a push even if the app is backgrounded),
  `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` config with the same dev-fallback pattern
  as `SESSION_SECRET`. Frontend: hand-written `apps/web/src/sw.ts` service worker
  (push + notificationclick handlers) required switching `vite-plugin-pwa` to
  `injectManifest` mode, and an explicit opt-in toggle
  (`apps/web/src/components/push-opt-in.tsx`) on the rider dashboard (push is
  rider-only for now — offer broadcast is the only send trigger, so a dispatcher
  toggle would opt in to nothing).

## Honest test-coverage boundary

Automated tests cover everything this app is responsible for: the API routes
(auth, validation, and that unsubscribe is scoped per-user — `apps/api/test/push.test.ts`,
8 tests), and the opt-in UI's real round-trip to that API
(`e2e/specs/push-optin.spec.ts`) — with the *browser vendor's* push service (Chrome's
FCM etc.) stubbed, since that's third-party infrastructure outside this app's code
and isn't reachable/deterministic in this sandboxed environment. Actual OS-level
push delivery is **not** claimed as tested; see `WORK_IN_PROGRESS.md` for the manual
verification steps. The realtime path itself (not push) has real proof:
`e2e/specs/realtime.spec.ts` asserts a live update lands within 5s, far under the
20s poll fallback, on an already-open page — a passing run isn't poll-timing luck.

## Commands run and results (2026-09-10)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run build --workspace @ronmacrae/contracts` | **PASS** |
| 2 | `npm run typecheck --workspace @ronmacrae/api` | **PASS** — 0 errors |
| 3 | `npm run test:unit --workspace @ronmacrae/api` | **PASS** — 7 files, **45/45** |
| 4 | `npm run typecheck --workspace @ronmacrae/web` | **PASS** — 0 errors (app + standalone `sw.ts` tsconfig) |
| 5 | `npm run test:unit --workspace @ronmacrae/web` | **PASS** — 3/3 |
| 6 | `npm run build --workspace @ronmacrae/web` | **PASS** — `injectManifest` PWA, 10 precache entries, `dist/sw.js` confirmed to contain `push`/`notificationclick` |
| 7 | `cd e2e && CI=1 npx playwright test` | **PASS** — **15/15** (12 pre-existing + 3 new) |
| 8 | `npm run lint` (repo root) | same 8 pre-existing errors, untouched files, not a regression |
| 9 | `npm audit --omit=dev` (repo root) | same 3 pre-existing production advisories as before `web-push` was added — no new one |

## Still open (Stages 5-6)

Foreground GPS, dispatcher map (`maplibre-gl` already a dependency, unused so far),
secure customer tracking hardening, then the final full-workflow gate pass and
preview/demo instructions. See `WORK_IN_PROGRESS.md` for the concrete next steps.

## Re-verify

```bash
npm run build --workspace @ronmacrae/contracts
npm run typecheck --workspace @ronmacrae/api && npm run test:unit --workspace @ronmacrae/api
npm run typecheck --workspace @ronmacrae/web && npm run test:unit --workspace @ronmacrae/web && npm run build --workspace @ronmacrae/web
cd e2e && CI=1 npx playwright test   # expect 15/15
```

---

# Delivery-offers Stage 5 — foreground GPS, dispatcher map, secure tracking (Claude Code, 2026-09-10)

**Status: PASS.** Full detail in `WORK_IN_PROGRESS.md`. Short version here.

## What was built

- Fixed a real gap first: real GPS reports (`RidersService.reportLocation`) never
  stopped the preview location simulator for the same rider's active job, so a real
  position would have been overwritten by the sim's next tick — one line
  (`ctx.sim.stopForJob(job.id)`) so real GPS reliably wins, matching what the
  simulator's own docstring already claimed.
- **Foreground GPS** (new `apps/web/src/lib/geolocation.ts` +
  `components/location-sharing.tsx`, on the rider dashboard): explicit opt-in,
  throttled `watchPosition` reports to the existing location-report route.
  Foreground-only is structural, not just a claim — hiding the tab clears the watch
  and requires an explicit "Resume sharing" tap, never silently keeps "sharing"
  shown while nothing is being sent.
- **Dispatcher map** (new `apps/web/src/pages/map.tsx`, code-split — `maplibre-gl`
  is ~1MB and only staff need it): live rider markers via the realtime
  `rider.location` message plus a new `GET /api/rider-locations` bootstrap endpoint,
  keyless OpenStreetMap tiles (no API key, matching `packages/geo`'s existing
  fallback convention). Each marker and list row shows `trackingState` and how
  stale the position is.
- **Secure customer tracking**: the public tracking page already handled the
  honesty requirements well (staleness, PIN gating, link expiry/revocation) — added
  a small read-only map (`components/courier-map.tsx`, also code-split) showing the
  last known point, nothing else needed changing.
- **Found while verifying, fixed though not part of the plan**: `maplibre-gl` was a
  previously-unused dependency carrying a **critical** XSS advisory. Activating it
  into the live render path this stage changed that from dormant to shipped, so
  upgraded `5.24.0 → 6.9.0` (this app's own usage, `Popup.setText()` never
  `.setHTML()`, likely wasn't on the vulnerable path regardless, but no reason to
  leave a critical advisory in place once it mattered). Verified with the full e2e
  suite, not just typecheck, since it's a major version bump.
- **Found and fixed (test-file only)**: this session's own accumulated test riders
  broke a pre-existing e2e spec's assumption that the seeded "Kei Bearer" rider is
  always dropdown option index 1 (rider lists sort alphabetically by name). Fixed
  `jobs.spec.ts` to select by finding the option robustly instead.
- **Noted, not fixed**: `API.riders.locationsFor(riderId)` is a pre-existing
  dangling contract route (declared, never implemented) — out of scope, nothing in
  this stage needed per-rider location history.

## Commands run and results (2026-09-10)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck --workspace @ronmacrae/api` | **PASS** — 0 errors |
| 2 | `npm run test:unit --workspace @ronmacrae/api` | **PASS** — 45/45 |
| 3 | `npm run typecheck --workspace @ronmacrae/web` | **PASS** — 0 errors |
| 4 | `npm run test:unit --workspace @ronmacrae/web` | **PASS** — 3/3 |
| 5 | `npm run build --workspace @ronmacrae/web` | **PASS** — main bundle back to ~282 kB, map code-split into its own chunk |
| 6 | `cd e2e && CI=1 npx playwright test` | **PASS** — **17/17** |
| 7 | `npm run lint` | same 8 pre-existing errors, unchanged |
| 8 | `npm audit --omit=dev` | **5 vulnerabilities, 0 critical** (was 6/1-critical before the maplibre-gl upgrade) |

## Still open (Stage 6 only)

One final combined gate run across the whole stack, and writing real preview/demo
instructions (credentials, commands, routes to visit) into this file. See
`WORK_IN_PROGRESS.md` for the exact checklist.

## Re-verify

```bash
npm run build --workspace @ronmacrae/contracts
npm run typecheck --workspace @ronmacrae/api && npm run test:unit --workspace @ronmacrae/api
npm run typecheck --workspace @ronmacrae/web && npm run test:unit --workspace @ronmacrae/web && npm run build --workspace @ronmacrae/web
cd e2e && CI=1 npx playwright test   # expect 17/17
npm audit --omit=dev                 # expect 0 critical
```

---

# Stage 6 — final combined verification + preview instructions (Claude Code, 2026-09-10)

**Status: PASS. All six of the original requirements have working, tested code
behind them.** This is the final stage — verification and documentation, not new
features. Everything below was actually run this session, fresh, in one pass —
not assumed from the per-stage runs in the sections above.

## Full combined gate run (root-level, all workspaces together)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck` (root — contracts, geo, money, notifications, api, web) | **PASS** — 0 errors in every workspace |
| 2 | `npm run test:unit` (root — this also runs e2e, since `@ronmacrae/e2e`'s own `test:unit` script is `playwright test`) | **PASS** — contracts+geo+money 8/8, notifications 6/6, api 45/45, web 3/3, **e2e 17/17** |
| 3 | `npm run build` (root — all workspaces, including `apps/api` to `dist/main.js`) | **PASS** — no errors; web build main bundle ~282 kB (map/courier-map code-split into their own chunks) |
| 4 | `npm run lint` (root) | **8 pre-existing errors**, all in `apps/api/src/modules/jobs/{proofs,repository,transition}.ts`, `settings.ts`, `tracking.ts` (unused imports) — present before this session started, in files never touched across all 5 stages. Not fixed (out of scope: not part of the offers/GPS/alerts work), but flagged clearly here rather than left silently buried in per-stage notes. |
| 5 | `npm audit --omit=dev` (root) | **5 vulnerabilities, 0 critical** — `deepmerge-ts`/`prisma` (high) and `react-router` (moderate), both pre-existing and both requiring a breaking major-version bump to fix. Not fixed (same reasoning as lint: real, but out of scope for this task, and each needs its own verification pass). The one critical finding that *was* in scope (`maplibre-gl`, made load-bearing by Stage 5) was fixed in that stage. |

## Preview server actually booted and exercised (not just built)

Ran the exact `make preview` flow for real this session:

```bash
npm run build --workspace @ronmacrae/web
WEB_DIST="$PWD/apps/web/dist" DEV_DB=1 QUEUE_DRIVER=memory NOTIFICATION_PROVIDER=memory npm run preview:api
```

- `GET /api/health` → `{"ok":true,...,"web":true,...}` — confirms the built PWA is
  being served from the API process on :3000, not just that the API boots.
- All five seeded demo logins tested for real against the running server (not
  assumed from `seed.ts`): `admin@ronmacrae.example` / `admin1234`,
  `dispatcher@ronmacrae.example` / `dispatch1234`,
  `accountant@ronmacrae.example` / `account1234`,
  `viewer@ronmacrae.example` / `viewer1234`, and rider `+8765550001` / `rider1234`
  ("Kei Bearer") — every one returned `200` with a real access token.
- `GET /map` (client-side route) → `200`, SPA shell served correctly.
- `GET /api/push/public-key` (Stage 4) and `GET /api/rider-locations` (Stage 5),
  both called with a real dispatcher token → both returned real data, confirming
  those routes work end-to-end in the built artifact, not just in dev/test mode.
- Server stopped cleanly afterward; port 3000 confirmed free.

## Preview / demo instructions (verified working, this session)

```bash
cd ronmacrae-dispatch
npm run build --workspace @ronmacrae/web
WEB_DIST="$PWD/apps/web/dist" DEV_DB=1 QUEUE_DRIVER=memory NOTIFICATION_PROVIDER=memory npm run preview:api
# Open http://127.0.0.1:3000
```

(Equivalent to `make preview`, except the Makefile's `preview` target doesn't set
`DEV_DB`/`QUEUE_DRIVER`/`NOTIFICATION_PROVIDER` itself — it relies on `.env` or
your shell already having them, per config.ts's zero-service DEV_DB defaults. Set
them explicitly as above if you haven't copied `.env.example` to `.env`.)

**Demo accounts** (from `apps/api/src/seed.ts` — run `npm run seed` first if the
database is empty):

| Role | Identifier | Password |
| --- | --- | --- |
| Admin | `admin@ronmacrae.example` | `admin1234` |
| Dispatcher | `dispatcher@ronmacrae.example` | `dispatch1234` |
| Accountant | `accountant@ronmacrae.example` | `account1234` |
| Viewer | `viewer@ronmacrae.example` | `viewer1234` |
| Rider ("Kei Bearer") | `+8765550001` | `rider1234` |

**Where to see each stage's work in the running preview:**

- **Address-first order creation (Stage 7)**: dispatcher → New Order — the
  destination address (search → pick a suggestion → drag the pin if needed →
  Confirm location) is the very first thing you fill in; the rest of the form
  (customer, pickup, product, urgent checkbox, payment) appears only after. Pickup
  defaults to the store address and is editable the same way.
- **Owner-only fee zones (Stage 7)**: log in as **admin** (not dispatcher) →
  Zones & Fares — a "Manage delivery-fee zones" section appears (create/edit/
  disable/delete, with an urgent surcharge field). Log in as dispatcher instead and
  that section is gone entirely — only the read-only zones table.
- **Offers (Stages 1-3)**: log in as dispatcher → Jobs → create a job (or use an
  existing `new` one) → click **Offers** on its row → Broadcast. In a second
  browser (or private window), log in as the rider → the offer appears under
  "Job offers" on the dashboard → Accept/Decline.
- **Live alerts (Stage 4, refined Stage 7)**: with both windows open side by side,
  broadcasting an offer or a rider accepting one should produce an in-app toast on
  the other side within a couple of seconds (no reload) — this is the realtime
  websocket path, not polling. A red badge on the rider's Dashboard nav tab counts
  unread alerts (clears on navigating). Directly assigning a job (Jobs screen,
  Assign button, not Broadcast) alerts only that one rider — a different rider
  logged in elsewhere sees nothing. An urgent order shows a red "Urgent" badge on
  the Jobs table row, the rider's job/offer cards, and the dispatcher's offer list.
- **Push (Stage 4)**: on the rider dashboard, "Enable push notifications" — the
  browser's own permission prompt appears (this is real, not the e2e's mocked
  version); a subsequent offer broadcast to that rider sends a real push via
  `web-push` using the dev VAPID keys.
- **Foreground GPS (Stage 5)**: on the rider dashboard, "Share my location" —
  the browser will ask for location permission.
- **Dispatcher map (Stage 5)**: dispatcher/admin nav → **Map** — shows rider
  markers live (from real GPS shares above, or the preview's own simulated
  rider movement once a job is assigned and the rider is heading to pickup).
- **Customer tracking (Stage 5)**: create/book a job as staff or via the public
  `/book` form, which returns a `/track/<token>` link — open it in an
  incognito window (no login) to see the customer-facing view, including the
  small courier map once a position exists.

## Known issues (consolidated — everything found but out of scope, across all 5 stages)

1. **`effectiveDatabaseUrl()` path-doubling** (`apps/api/src/config.ts`, and the
   equivalent in `scripts/prepare-db.mjs`) — an absolute `file:/...` `DATABASE_URL`
   under `DEV_DB=1` gets `apiRoot` prepended twice, because the strip-`"file:"`
   regex also eats the URL's leading `/`. Doesn't affect the app's own `.env`
   convention (relative `file:./data/dev.db`). 2-line fix identified in Stage 1/2
   notes above; not applied (unrelated to the offers/GPS/alerts task).
2. **`API.riders.locationsFor(riderId)`** (`packages/contracts/src/routes.ts`) is a
   pre-existing dangling route constant — declared, no backend implementation.
   Presumably meant for per-rider location history; nothing in this work needed it.
3. **8 pre-existing lint errors** (unused imports) in
   `apps/api/src/modules/jobs/{proofs,repository,transition}.ts`, `settings.ts`,
   `tracking.ts` — present before this session, in files never touched.
4. **`deepmerge-ts`/`prisma` (high) and `react-router` (moderate) audit
   advisories** — both pre-existing, both need a breaking major-version bump to
   fix (`prisma@6.12.0` downgrade for the first — check whether that's actually
   older or a different major line before assuming it's safe to apply blindly;
   `react-router-dom@7.18.3` for the second, a major version jump from the `^6`
   currently used, likely with real API changes given this app's routes). Neither
   touched this session — `maplibre-gl`'s critical finding was fixed (Stage 5)
   because this session made it load-bearing; these two were already in active
   use before this session and are a larger, separate verification effort.
5. **Native mobile app**: explicitly out of scope from the start, per the user's
   original instructions. Not started.

## Re-verify (Stage 6 — the complete gate list, one command block)

```bash
npm run typecheck        # root: all workspaces, expect 0 errors everywhere
npm run test:unit        # root: also runs e2e — expect api 45/45, web 3/3, e2e 17/17
npm run build             # root: all workspaces including api dist + web dist
npm run lint              # expect exactly the 8 pre-existing errors listed above
npm audit --omit=dev      # expect 5 vulnerabilities, 0 critical
```

---

# Stage 7 — address-first order creation, owner-only fee zones, alert refinements,
# dev-db cleanup (Claude Code, 2026-09-10)

**Status: PASS.** Requested mid-manual-testing, after Stage 6. Full narrative and
reasoning in `WORK_IN_PROGRESS.md`'s Stage 7 section — this is the verification
summary.

## What changed

1. **Address-first order creation**: `apps/web/src/pages/new-job.tsx` rewritten —
   destination address (search → suggestions → draggable map pin → explicit
   confirm) is step 1; the rest of the form is hidden until it's confirmed. New
   `apps/api/src/modules/geo.ts` (`POST /api/geo/geocode` multi-result search,
   `POST /api/geo/reverse`), new `packages/geo` `searchAddresses()` capability. Both
   "address search unavailable" (existing deterministic offline fallback, now
   flagged `degraded: true` to the UI) and "map fails to load" (error boundary,
   falls back to coordinates-only) are handled explicitly, not just hoped away.
   Customer capture is now First name (required) / Last name (optional) — combined
   server-side into the existing `Customer.name`, no schema change. Pickup defaults
   to 15-17 Half Way Tree Road, Kingston (geocoded once, still editable via the
   same flow). Requested delivery is now date-only + an "Urgent delivery" checkbox
   (replacing the old Normal/Express/Urgent select in this form). Delivery fee
   auto-suggests from the real fare engine once both points are confirmed, stays
   editable.
2. **Owner-only delivery-fee zones**: `Zone.urgentSurchargeFee` added (additive
   migration, `dev.db` backed up first). Zone create/update/delete now `admin`-only
   (was `admin`+`dispatcher`); delete refuses if any Job references the zone. New
   admin-only UI (`apps/web/src/components/zone-manager.tsx`) creates a zone from a
   geocoded center point (auto-generated coverage polygon, shared helper with
   `seed.ts`) instead of a hand-drawn one. `FareEngine.quote()` applies the
   destination zone's flat urgent surcharge when requested.
3. **Courier alerts refined**: direct assignment now also sends a push (previously
   only offer-broadcast did) and carries a `source: "assign"` vs `"offer"` field so
   the frontend can tell direct assignment from a self-accepted offer. New unread
   indicator (badge on the Dashboard nav tab). Urgent priority now shown as a
   prominent red badge everywhere a job/offer appears to dispatchers or riders.
   Privacy re-verified: no customer phone/name/PIN in any toast or push payload.
4. **E2e isolated from the live dev db**: `e2e/playwright.config.ts` now points
   e2e's server at its own `e2e-test.db`, never `apps/api/data/dev.db`. This also
   fixed the root cause of test flakiness hit twice before this session
   (accumulated e2e-created riders/data interfering with other tests or the human's
   manual-preview view of `dev.db`).
5. **Dev-db order cleanup**: backed up `dev.db` again, deleted all 126 accumulated
   `Job` rows (cascade handled `JobEvent`/`JobOffer`/`RiderAssignment`/
   `TrackingLink`/`Proof` automatically per the schema's own relations). Users,
   riders, customers, zones, fare rules, settings, and push subscriptions all
   confirmed unchanged (exact row-count match before/after).

## A real bug found and fixed (not just a test-flakiness workaround)

`RidersService.create()` (`apps/api/src/modules/riders.ts`) hardcodes every new
rider to `status: "available"` at creation, ignoring the schema's own
`@default(offline)`. Found while debugging `e2e/specs/alerts.spec.ts` failing
intermittently under full-parallel-suite load (passed 3/3 in isolation, failed on
nearly every full-suite run) — a test's "uninvolved rider" fixture was silently
eligible for *other, concurrently-running specs'* unscoped broadcasts because it
was `available` from creation, not `offline` as assumed. Fixed the test (explicit
`status: "offline"` PATCH after creation); the underlying production behavior
(new riders are immediately live/offerable, not created "off shift") is
**intentionally not changed** here — that's a product decision, not a bug fix,
flagged in Known Issues below for a deliberate call rather than a silent change.
Verified stable across 3 consecutive full-suite e2e runs after the fix (was
reproducing on nearly every run before it).

## Commands run and results (2026-09-10)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck` (root) | **PASS** — 0 errors, all 6 workspaces |
| 2 | `npm run test:unit` (root) | **PASS** — api **55/55**, web 3/3, contracts/geo/money 8/8, notifications 6/6, **e2e 18/18** |
| 3 | `npm run build` (root) | **PASS** — all workspaces |
| 4 | `npm run lint` | Same 8 pre-existing errors, unchanged |
| 5 | `npm audit --omit=dev` | Same 5 vulnerabilities / 0 critical, unchanged |
| 6 | Full e2e suite × 3 consecutive full-parallel runs (post `RidersService` test fix) | **18/18 every time** |
| 7 | `dev.db` cleanup verification (row counts before/after) | Job/JobEvent/JobOffer/RiderAssignment/TrackingLink/Proof: all → 0. User 66, Rider 62, Customer 52, Zone 3, FareRule 1, Setting 1, PushSubscription 1: all **unchanged** |

## Known issues (updated)

Everything from Stage 6's list still applies, plus:

6. **`RidersService.create()` hardcodes `status: "available"`** on every new
   rider — a freshly-created rider is immediately eligible for offers before
   anyone has confirmed they're on shift. Not changed (needs a product decision,
   not a unilateral fix) — see `WORK_IN_PROGRESS.md` Stage 7 for the detail.

## Re-verify (Stage 7)

```bash
npm run typecheck && npm run test:unit && npm run build   # root — expect 0 errors, api 55/55, e2e 18/18, clean build
npm run lint && npm audit --omit=dev                       # expect 8 pre-existing lint errors, 5 vulns / 0 critical
```

---

# Stage 8 — Fix address entry (pre-production hardening, 2026-09-10)

Full detail in `WORK_IN_PROGRESS.md` under "Stage 8 — Fix address entry (DONE)".
Summary for resuming agents:

**Bug fixed**: `apps/web/src/components/address-picker.tsx` silently overwrote
the user's typed address text in two places — picking a search suggestion, and
dragging the map pin (reverse-geocode). Both are now informational-only;
typed text changes **only** from direct typing.

**Schema change**: `Job.addressProviderText` / `Job.pickupAddressProviderText`
(nullable strings) added, additive-only, `dev.db` backed up first as
`data/dev.db.bak-preprod-20260910-165227` before the push. Row counts
unaffected (only new nullable columns, no data touched).

**Files changed this stage**:
- `apps/api/prisma/schema.prisma` (+2 columns on `Job`)
- `packages/contracts/src/types.ts` (`JobDto` +2 fields)
- `apps/api/src/modules/jobs/dto.ts` (`jobToDto()` mapping)
- `apps/api/src/modules/jobs/create.ts` (`CreateJobBody`/`UpdateJobBody` + both data-mapping objects)
- `apps/web/src/components/address-picker.tsx` (rewritten — typed-text-authoritative)
- `apps/web/src/pages/new-job.tsx` (new `ConfirmedLocation` shape; default pickup keeps exact text; new fields sent to `POST /jobs`)
- New tests: `apps/web/src/components/address-picker.test.tsx` (5), `apps/api/test/jobs-address.test.ts` (3)

## Commands run and results (Stage 8)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck --workspaces` (root) | **PASS** — 0 errors, all real workspaces (`e2e` has no typecheck script, pre-existing) |
| 2 | `npx vitest run` (apps/web) | **PASS** — 8/8 (3 pre-existing + 5 new) |
| 3 | `npx vitest run` (apps/api) | **PASS** — 58/58 (55 pre-existing + 3 new) |
| 4 | `npm run build --workspace @ronmacrae/web` | **PASS** — clean production build |
| 5 | `DEV_DB=1 npm run db:prepare` (after backing up `dev.db`) | **PASS** — clean push, additive only, no data-loss warning |

## Known issues (unchanged from Stage 7 + this stage's own note)

Everything from Stage 6/7's lists still applies. Nothing new introduced by
Stage 8. One thing explicitly *not* done, by design: the public customer-facing
delivery-request form (`apps/web/src/pages/book.tsx`) still takes the
destination as a plain text field with no geocoding/pin step at all — it has no
overwrite bug (nothing auto-fills it), so out of scope for this bug-fix stage;
adding a pin-confirmation step there would be a feature request, not part of
"fix address entry".

## Re-verify (Stage 8)

```bash
npm run typecheck --workspaces
npm run test --workspace @ronmacrae/web
npm run test --workspace @ronmacrae/api
npm run build --workspace @ronmacrae/web
```

---

# Stage 9 — Rider availability + multi-job capacity (pre-production hardening, 2026-09-10)

Full detail in `WORK_IN_PROGRESS.md` under "Stage 9 — Rider availability toggle
+ configurable multi-job capacity (DONE)". Summary for resuming agents:

**Bug fixed**: accepting a job silently flipped `Rider.status` from
`available` to `on_job` (`transition.ts`), which excluded the rider from
further offer broadcasts (`eligibleRiders()` requires `status: "available"`)
even while well under capacity — and the rider dashboard's toggle then
disabled itself while `on_job`, so the rider couldn't even manually fix it.
Fix: stopped job lifecycle code from ever touching `rider.status` at all
(removed the auto-mutations in `transition.ts` and `assign.ts`'s
`unassignJob`) — status is now 100% rider/staff-controlled via the existing
`PATCH /api/riders/:id/status`. No schema change was needed.

**Also hardened**: added a capacity re-check inside the offer-accept
transaction (`offers.ts`) — a rider can now hold several open offers at once
(since carrying jobs no longer disqualifies them), so accepting two near
capacity had to be re-verified atomically, not just at broadcast time.

**Files changed this stage**:
- `apps/api/src/modules/jobs/transition.ts` (removed auto status mutation)
- `apps/api/src/modules/jobs/assign.ts` (removed auto status mutation in `unassignJob`)
- `apps/api/src/modules/offers.ts` (capacity re-check in accept transaction)
- `apps/api/src/modules/riders.ts` (`dailyCapacity` create default 15→5; `setStatus`'s offline-guard generalized to active-job-count instead of `status === "on_job"`)
- `apps/web/src/pages/rider-dashboard.tsx` (toggle always enabled, 2-state available/unavailable, active-job-count + capacity + at-capacity warning)
- `e2e/specs/booking.spec.ts` (fixed 2 assertions broken by Stage 8's AddressPicker copy/UI changes — pre-existing gap in that stage's own verification, caught and fixed here)
- New tests: 4 new cases in `apps/api/test/offers.test.ts` (62 total, up from 58)

## Commands run and results (Stage 9)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck --workspaces` (root) | **PASS** — 0 errors |
| 2 | `npx vitest run` (apps/api) | **PASS** — 62/62 (58 prior + 4 new) |
| 3 | `npx vitest run` / `npm run build` (apps/web) | **PASS** — 8/8, clean build |
| 4 | Full e2e suite (`alerts`,`booking`,`gps-map`,`jobs`,`offers`,`push-optin`,`realtime`,`rider-dashboard`,`smoke` — 17 tests), serial | **PASS** — 17/17 |
| 5 | Same suite at 3x parallelism, several runs | Intermittent failures, confirmed (via isolated re-runs) to be the pre-existing, already-known `RidersService.create()` "every new rider defaults to status=available" cross-spec interference (see Known Issues below) — not a Stage 9 regression |

**Environment note**: found a long-lived manual preview server + TLS proxy
from earlier in this session still bound to port 3000 against the real
`dev.db`, being silently reused by Playwright's `reuseExistingServer` instead
of its own isolated e2e server. Stopped both so e2e verification actually ran
against its own isolated `e2e-test.db`. If manual/real-device preview access
is needed again, it will need restarting.

## Known issues (unchanged from Stage 7/8, still not fixed by design)

`RidersService.create()` still hardcodes `status: "available"` on every new
rider — still an intentional non-fix pending a product decision (see Stage
7's note). This stage's own new capacity/status tests avoid depending on it by
always setting rider status/capacity explicitly.

## Re-verify (Stage 9)

```bash
npm run typecheck --workspaces
npm run test --workspace @ronmacrae/api
npm run test --workspace @ronmacrae/web
cd e2e && npx playwright test --workers=1   # serial, to avoid the known cross-spec flakiness above
```

---

# Stage 10 — Rider notification repair (pre-production hardening, 2026-09-10)

Full detail in `WORK_IN_PROGRESS.md` under "Stage 10 — Diagnose and repair
rider notifications (DONE)". Summary for resuming agents:

**Diagnosis**: broadcast → toast → unread badge already worked; Stage 9 fixed
the eligibility bug. Four real gaps found by reading the code: (1) no alert
sound anywhere in the app, (2) no connection-state indicator (only an unused
internal boolean), (3) reconnecting a dropped socket never re-fetched
anything, (4) offer expiry only updated on the next poll/read, not
immediately. All four fixed; unavailable-rider exclusion, assignment scoping,
and push-independence were verified already correct, not touched.

**Files changed this stage**:
- `apps/web/src/lib/alert-sound.ts` (new — synthesized tone, no asset)
- `apps/web/src/lib/realtime.tsx` (`status: live|reconnecting|offline`, `onReconnect()`)
- `apps/web/src/components/layout.tsx` (visible connection-status indicator)
- `apps/web/src/components/alerts-toaster.tsx` (plays the alert sound)
- `apps/web/src/components/job-offers-panel.tsx` (reconnect refetch + client-side expiry)
- `apps/web/src/pages/rider-dashboard.tsx` (reconnect refetch + client-side expiry on OfferCard)
- `apps/web/src/pages/map.tsx` (reconnect refetch of rider locations)
- `apps/api/test/offers.test.ts` (fixed a too-narrow cast — a real `tsc` error Stage 9's vitest-only check had missed)
- New: `e2e/specs/multi-job-notifications.spec.ts` (two-real-browser-session verification)

## Commands run and results (Stage 10)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck --workspaces` (root) | **PASS** — 0 errors (also caught + fixed a Stage 9 test-file type error missed by vitest's esbuild transform) |
| 2 | `npx vitest run` (apps/api) | **PASS** — 62/62 |
| 3 | `npx vitest run` / `npm run build` (apps/web) | **PASS** — 8/8, clean build |
| 4 | Full e2e suite (18 tests, incl. new spec), serial | **PASS** — 18/18 |
| 5 | Same suite at 3x parallelism | **PASS** — 18/18 (no flakiness reproduced this run) |

**Push credentials**: present in this dev/preview environment (config.ts's
existing dev-mode VAPID fallback) — not missing, so nothing to report as a new
blocker. Production must still set its own `VAPID_PUBLIC_KEY`/
`VAPID_PRIVATE_KEY` (already documented, unchanged standing item). In-app
realtime alerts do not depend on push either way (confirmed by reading the
code — toast/badge/sound are driven purely by the websocket).

## Re-verify (Stage 10)

```bash
npm run typecheck --workspaces
npm run test --workspace @ronmacrae/api
npm run test --workspace @ronmacrae/web
cd e2e && npx playwright test --workers=1
```

---

# Stage 11 — Remove extra test riders (pre-production hardening, 2026-09-10)

Full detail in `WORK_IN_PROGRESS.md` under "Stage 11 — Remove extra test
riders safely (DONE)". Summary for resuming agents:

**Found**: 115 riders in `dev.db`, 114 disposable test riders + 1 real one
(Kei Bearer, `+8765550001`), from earlier ad-hoc testing against `dev.db`
directly (not from `seed.ts`, confirmed safe/idempotent).

**Backup**: `apps/api/data/dev.db.bak-riders-20260910-173947` (gitignored),
taken before any deletion.

**New script**: `apps/api/scripts/remove-test-riders.mjs` (dry-run by
default, `--yes` to execute, transactional, refuses to run unless exactly one
rider matches the keep-phone). Relies entirely on the schema's own
`onDelete` behavior (checked first, not assumed): `Job.rider` is `SetNull`
(jobs survive, just lose `riderId`); every other rider-owned table
(`JobOffer`/`RiderAssignment`/`RiderLocation`/`Route`/`ReconDaily`/`Payout`/
`SosAlert`) is `Cascade`. A removed rider's login (`User` row) is deleted
explicitly right after (that relation points the other way), which cascades
its `Session`/`PushSubscription` rows too.

**Result**: Rider 115→1, User 119→5 (4 staff unchanged + Kei Bearer),
Customer/Zone/Setting/Job counts all unchanged (17 jobs lost `riderId`, zero
jobs deleted). Zero orphaned rows confirmed via raw SQL after. Live-booted
the API against the cleaned db and confirmed both Kei Bearer's and the
dispatcher's logins still work, and `GET /api/riders` returns exactly one row.

## Commands run and results (Stage 11)

| # | Command | Result |
| --- | --- | --- |
| 1 | `cp data/dev.db data/dev.db.bak-riders-20260910-173947` | Backup created, gitignored |
| 2 | `node scripts/remove-test-riders.mjs` (dry run) | Printed exact planned changes, no writes |
| 3 | `node scripts/remove-test-riders.mjs --yes` | Executed; post-check passed (riders=1, customers/zones/settings/staff-users/jobs unchanged) |
| 4 | Raw SQL orphan check (5 queries) | **0 orphans** in every case |
| 5 | Live API boot against cleaned `dev.db` + login as Kei Bearer + dispatcher + `GET /api/riders` | **PASS** — both logins work, exactly 1 rider returned |
| 6 | `npx vitest run` (apps/api, isolated test db, unaffected by design) | **PASS** — 62/62 |
| 7 | 2 e2e specs (isolated `e2e-test.db`, unaffected by design) | **PASS** — 2/2 |

## Re-verify (Stage 11)

```bash
sqlite3 apps/api/data/dev.db "SELECT COUNT(*) FROM Rider;"   # expect 1
sqlite3 apps/api/data/dev.db "SELECT name, phone FROM Rider;" # expect Kei Bearer, +8765550001
```

---

# Stage 12 — 5A: COD reconciliation ledger (pre-production hardening, 2026-09-10)

Full detail in `WORK_IN_PROGRESS.md` under "Stage 12 — 5A: COD reconciliation
ledger (DONE)". Summary for resuming agents:

**Found**: `POST /api/jobs/:id/collect` already existed but was never called
from the frontend — no working COD recording UI existed at all before this
stage. Also found and fixed a real permission gap while extending it: it
previously let ANY authenticated staff role (including accountant/viewer)
record a collection, with no restriction.

**Schema** (backed up first as `dev.db.bak-cod-20260910-174615`): added
`codStatus`/`codCollectedAt`/`codHandedInAmount`/`codHandoverAt`/
`codRiderNote`/`codAccountantNote`/`codApprovedById`/`codApprovedAt` to `Job`
(reusing existing `amountExpected`/`amountCollected`), plus a new append-only
`CodEvent` audit-trail model. `ReconDaily` (an existing per-rider-per-day
aggregate) was inspected and deliberately left alone — doesn't fit a per-job
ledger with this exact status vocabulary.

**Backend**: new `apps/api/src/modules/cod.ts` (`GET /api/cod` board,
`POST /api/jobs/:id/cod/hand-in|approve|dispute`, `GET .../cod/events`);
extended `recordCollection()` in `payment.ts` to drive `codStatus` too and
fixed its permission gap (rider-own-job or admin/dispatcher only). Approved
entries are locked against further rider edits (409); a deliberate accountant
dispute can still reopen one, itself audited. Shortage/overage is a computed
DTO field, never stored. Confirmed the public tracking DTO
(`TrackingPublicDto`, hand-built, doesn't reuse `jobToDto`) carries none of
this.

**Frontend**: `CodPanel` on the rider dashboard's job cards (collect/hand-in
actions, status badge, three clearly separate figures); new `/cod` page
(staff-only nav tab) — filterable board, approve/dispute for admin/accountant,
read-only monitor view for dispatcher/viewer.

## Commands run and results (Stage 12)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck --workspaces` (root) | **PASS** — 0 errors |
| 2 | `npx vitest run` (apps/api) | **PASS** — 72/72 (62 prior + 10 new) |
| 3 | `npx vitest run` / `npm run build` (apps/web) | **PASS** — 8/8, clean build |
| 4 | Full e2e suite (19 tests, incl. new `cod.spec.ts`), serial | **PASS** — 19/19 |

## Re-verify (Stage 12)

```bash
npm run typecheck --workspaces
npm run test --workspace @ronmacrae/api
npm run test --workspace @ronmacrae/web
cd e2e && npx playwright test --workers=1
```

---

# Stage 13 — 5B: Rider route queue (pre-production hardening, 2026-09-10)

Full detail in `WORK_IN_PROGRESS.md` under "Stage 13 — 5B: Rider route queue
(DONE)". Summary for resuming agents:

**Found**: `Job.routeSeq` already existed in the schema and DTO but nothing
ever wrote to it — no schema change needed. A separate, unrelated `Route`/
`RouteStop`/`optimize` scaffold exists for a future real routing engine;
inspected and deliberately left alone (wrong fit for this stage's "honest,
no ETA claims" requirement).

**Backend**: one new endpoint, `POST /api/bearer/jobs/reorder` (rider-only,
all-or-nothing — submitted id set must exactly match the rider's current
active jobs or the whole call is rejected). Expanded `JobSummaryDto` with
`point`/`pickupAddressText`/`pickupPoint`/`routeSeq` so the dispatcher's
read-only queue view doesn't need a heavier per-job fetch.

**Frontend**: new shared `apps/web/src/components/route-queue.tsx`
(`RouteQueue` + helpers) — a compact ↑/↓-reorderable queue section on the
rider dashboard (next stop, address, COD amount, requested date, urgent
badge, "Open in Maps" link to the device's own nav app) and a read-only
`RiderQueuePanel` on the dispatcher's Jobs screen (new "Route queue" button
per assigned job row). Default order (before any manual reorder): routeSeq →
requested date → job-creation order (FIFO) — deterministic client-side.

## Commands run and results (Stage 13)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck --workspaces` (root) | **PASS** — 0 errors |
| 2 | `npx vitest run` (apps/api) | **PASS** — 77/77 (72 prior + 5 new) |
| 3 | `npx vitest run` / `npm run build` (apps/web) | **PASS** — 8/8, clean build |
| 4 | Full e2e suite (20 tests, incl. new `route-queue.spec.ts`), serial | **PASS** — 20/20 |

## Re-verify (Stage 13)

```bash
npm run typecheck --workspaces
npm run test --workspace @ronmacrae/api
npm run test --workspace @ronmacrae/web
cd e2e && npx playwright test --workers=1
```

---

# Stage 14 — 5C: Dispatcher operations board (pre-production hardening, 2026-09-10)

Full detail in `WORK_IN_PROGRESS.md` under "Stage 14 — 5C: Dispatcher
operations board (DONE)". Summary for resuming agents:

**Backend**: one new aggregation endpoint, `GET /api/ops-board` (admin/
dispatcher/accountant/viewer) — riders (status/availability/active-count/
capacity/remaining/`connected` via `RealtimeHub.clientForRider()`, newly
surfaced/location with an honest `stale` flag — 5min threshold — and `null`
rather than a fabricated point when there's no report at all), system-wide
waiting offers (didn't exist before), urgent jobs, overdue jobs
(`promisedAt`/`scheduledAt` passed, still active), COD awaiting handover
(`codStatus: handed_in`, from Stage 12). Read-only aggregation — no new
write-permission surface.

**Frontend**: new `/ops` page + nav tab — riders table with Call/Message
links and an inline read-only route-queue toggle, plus four list sections.
Extracted `ReadOnlyRiderQueue` into `route-queue.tsx` as a shared component
(Jobs screen + this board now use one implementation).

## Commands run and results (Stage 14)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck --workspaces` (root) | **PASS** — 0 errors |
| 2 | `npx vitest run` (apps/api) | **PASS** — 91/91 (84 prior + 7 new) |
| 3 | `npx vitest run` / `npm run build` (apps/web) | **PASS** — 8/8, clean build |
| 4 | Full e2e suite (21 tests, incl. new `ops-board.spec.ts`), serial, fresh `e2e-test.db` | **PASS** — 21/21 in ~21s |

**Housekeeping note**: if e2e specs start running unusually slowly (minutes
instead of ~20-25s), delete `apps/api/data/e2e-test.db` (disposable,
gitignored) before assuming a real regression — it accumulates across many
separate `npx playwright test` invocations in one session since the
webServer's `reuseExistingServer` setting keeps reusing it and `npm run seed`
only runs on that server's first start.

## Re-verify (Stage 14)

```bash
npm run typecheck --workspaces
npm run test --workspace @ronmacrae/api
npm run test --workspace @ronmacrae/web
rm -f apps/api/data/e2e-test.db && cd e2e && npx playwright test --workers=1
```

---

# Stage 15 — 5D: Customer status messages (pre-production hardening, 2026-09-10)

Full detail in `WORK_IN_PROGRESS.md` under "Stage 15 — 5D: Customer status
messages + notification log (DONE)". Summary for resuming agents:

**Found**: extensive existing infra (providers, templates, outbox, queue,
a notifications page) — but three real gaps: (1) `TwilioProvider` claimed
"delivered" merely because Twilio *accepted* the API call — a genuine
evidence violation, now fixed with a `sent` status plus a signature-verified
Twilio status-callback webhook that's the only path to a confirmed
`delivered`/`failed`; (2) "order created" and "heading to pickup" were never
actually triggered despite templates existing for the former; (3) "in
transit" and "near destination" sent the identical message. All fixed and
wired: `JobNotifier.forOrderCreated()` (first tracking link only) and
`.forRiderStage()` (heading_to_pickup only) added; `delivering` split onto
its own `near_destination` template.

**Also found and fixed**: staff-booked customers (`POST /customers`)
defaulted `consentTracking` to `false` — meaning the ordinary booking flow
sent zero customer notifications ever, silently. Flipped to `true` (matches
the public self-service form's own existing default; `consentMarketing`
stays separately opt-in).

**Configurable templates**: new `notificationTemplates` Setting (admin-only
write, merges — not replaces — so one save can't wipe out another
template's override, caught by a dedicated test), read by everyone who can
see the Notifications page.

**Frontend**: rewrote `notifications.tsx` — friendly Pending/Sent/Delivered/
Failed/Skipped labels, error text + Retry on failed rows, an explicit
"Preview mode" banner with documented future-activation steps (no live
provider connected), and an admin-editable/staff-readable templates panel.

## Commands run and results (Stage 15)

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck --workspaces` (root) | **PASS** — 0 errors |
| 2 | `npx vitest run` (packages/notifications) | **PASS** — 6/6 (1 fixed to match the corrected "sent" status) |
| 3 | `npx vitest run` (apps/api) | **PASS** — 98/98 (84 prior + 14 new) |
| 4 | `npx vitest run` / `npm run build` (apps/web) | **PASS** — 8/8, clean build |
| 5 | Full e2e suite (23 tests, incl. 2 new), serial, fresh `e2e-test.db` | **PASS** — 23/23 |

## Re-verify (Stage 15)

```bash
npm run typecheck --workspaces
npm run test --workspace @ronmacrae/notifications
npm run test --workspace @ronmacrae/api
npm run test --workspace @ronmacrae/web
rm -f apps/api/data/e2e-test.db && cd e2e && npx playwright test --workers=1
```

## Next: Stage 16 (5E)

Operating reports for owner/accountant — deliveries completed/active/
failed-cancelled, delivery fees, COD expected/collected/handed-in/
outstanding/shortages/overages, rider earnings/jobs-completed/avg delivery
time, urgent-delivery count; filterable by date range/rider/zone/status/
payment method; honest labeling of missing/incomplete data; CSV export
without exposing PINs or unnecessary customer data. See
`WORK_IN_PROGRESS.md`'s Stage plan table for the full remaining Stage
16–18 sequence.

# Phase 2 — Dispatcher Jobs Screen Checkpoint

**Status: PASS** — the dispatcher Jobs screen is built and verified end-to-end in a real
browser (Playwright). It lists jobs with filters and supports rider assignment
(assign / reassign / unassign) plus status moves, all against the Phase 1 jobs backend.

## Scope

- `apps/web/src/pages/jobs.tsx` (new, 317 lines) — the Jobs screen: filterable job table
  (status / source / debounced search), status badges, stage, expected amount, rider, and
  per-row actions. Rider picker for assign/reassign (active riders from `GET /riders`),
  unassign, and a "move to" select driven by the contracts state machine
  (`allowedTransitions`, minus `assigned`/`new` which have dedicated buttons).
  Write actions render only for `admin`/`dispatcher`; other staff see a read-only badge.
- `apps/web/src/app.tsx` — `/jobs` route (protected, staff layout).
- `apps/web/src/components/layout.tsx` — "Jobs" nav tab, hidden for the `rider` role.
- `e2e/specs/jobs.spec.ts` (new, 57 lines) — browser verification spec.

## Fixes applied (concrete errors, small patches)

1. `apps/api/src/server.ts` — the API **crashed at boot**
   (`ERR_MODULE_NOT_FOUND: ./modules/requests.js`; also `bearer.js`, `geo.js`). These three
   route modules do not exist, so their imports and registrations were removed. The app
   now boots with exactly the modules that exist. This also cleared the 3 remaining
   Phase-1 `tsc` errors (API typecheck is now fully green).
2. `packages/contracts` — the built `dist` was **stale** (missing newer `state-machine`
   exports such as `ACTIVE_JOB_STATUSES`), breaking the API at runtime. Rebuilt the
   package; `dist` is now in sync with `src`.
3. `e2e/specs/jobs.spec.ts` — two locator fixes while bringing the spec green:
   `selectOption` label must be an exact string (not a regex), and the rider-name
   assertion uses `{ exact: true }` so it matches the cell, not hidden `<option>` text.

## Commands run and results

| Command (working dir) | Result |
| --- | --- |
| `npm run typecheck` (`apps/web`) | 0 errors |
| `npm run test:unit` (`apps/web`) | 3/3 pass |
| `npm run build` (`apps/web`) | success (233 kB JS bundle, PWA generated) |
| `npm run build --workspace @ronmacrae/contracts` (repo root) | success (dist refreshed) |
| `npm run typecheck` (`apps/api`) | 0 errors (Phase 1 baseline was 3) |
| `npm run test:unit` (`apps/api`) | 27/27 pass |
| boot: `DEV_DB=1 … npx tsx src/main.ts` (`apps/api`) | listens in ~3 s, `GET /api/health` → `ok: true` |
| `npx playwright test` (`e2e`) | **5/5 pass** (4 smoke + new Jobs spec, chromium) |

The Jobs e2e verifies the full lifecycle in the browser: dispatcher UI login → job created
via `POST /api/jobs` appears in the queue → rider "Kei Bearer" selected → **Assign** →
badge `assigned`, stage "Heading to pickup", rider shown → **Unassign** → back to `new`,
rider "—" → **Move to cancelled** → badge `cancelled`.

## Out of scope / notes

- The unimplemented `bearer` / `geo` / `requests` API modules (and their contracts route
  constants) remain for future phases; the web app only calls routes that exist.
- `apps/web` unit tests still cover the API client only; the Jobs screen is verified via
  typecheck + production build + the Playwright spec. A jsdom component test for the
  screen would be a reasonable follow-up.
- The dev sqlite DB (`apps/api/data/dev.db`) accumulates jobs created by e2e runs.

## Re-verify

```bash
cd apps/web && npm run typecheck && npm run test:unit && npm run build
cd apps/api && npm run typecheck && npm run test:unit
cd e2e && npx playwright test   # boots the seeded API on :3000; expect 5/5 pass
```

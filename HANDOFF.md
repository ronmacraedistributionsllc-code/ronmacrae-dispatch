# HANDOFF — Ronmacrae Dispatch

**This is a recovery/safety checkpoint, created before any further feature work.**
Read this file first if you are picking this project up cold.

---

## 1. Exact recovery point

| | |
|---|---|
| Commit hash | *(a hash cannot embed itself — resolve it with `git rev-parse pre-courier-branding-handoff^{}`, or see the tag below and the session report that created it)* |
| Tag | `pre-courier-branding-handoff` (annotated, pushed) — the authoritative pointer to this checkpoint |
| Branch | `master` |
| Remote | `origin` → `https://github.com/ronmacraedistributionsllc-code/ronmacrae-dispatch.git` (private) |
| Remote status at checkpoint | `master` up to date with `origin/master`, 0 ahead / 0 behind, working tree clean before this commit |

To return to exactly this point later, from a clean checkout:

```bash
git fetch origin --tags
git checkout pre-courier-branding-handoff
```

This never rewrites history — it only adds one commit and one tag on top of `master`. Nothing before it was reset, cleaned, rebased, squashed, or deleted.

---

## 2. What is actually implemented and verified

Ronmacrae Dispatch is a multi-tenant Jamaica delivery-dispatch platform: one courier business (Ronmacrae Distributions) serving multiple merchant clients and outside fleet ("logistics/bearer company") partners, with one shared login routing everyone to their own portal.

**Implemented, with passing automated coverage** (see §5 for the exact commands/numbers):

- Staff roles (admin/dispatcher/accountant/viewer) with business-scoped dispatch board, jobs, zones/fares, settlements, COD reconciliation, reports.
- Rider ("bearer") face: public self-signup with email verification, admin approval, three-step delivery flow (accept → collect → deliver with PIN), live job offers over WebSockets, route queue, cash summary, push notifications (Web Push).
- Merchant Portal: separate login face (same shared sign-in page, different token type), own orders only, catalog management, delivery ratings.
- Logistics/Bearer Company Portal: separate login face, read-only fleet dashboard of Platform-Admin-attached riders, fleet messaging.
- Platform Admin (owner) console: search/inspect/approve/block/disable/reactivate across every business, merchant, logistics company, rider, and staff account; rider platform-approval and attachment (freelance / one merchant / one logistics company); rating moderation; platform-wide audit log; a shared inbox for admin-to-anyone messaging.
- Public customer flows: multi-item order form (per-merchant or direct), tracking page with three separate conversations (customer↔dispatch, customer↔rider, rider↔dispatch) and post-delivery rating, "My Packages" cross-business phone-lookup dashboard, optional email+password customer account.
- Invite/onboarding flow for staff (send, resend, revoke, accept).
- COD cash reconciliation: collect → hand-in → approve/dispute (with an explicit shortage/overage/other type) → optional reversible archival of settled entries; a business-wide shortage/overage summary rollup.
- Operating reports: date/rider/zone/payment/logistics-company filters, per-rider and per-logistics-company completed-job breakdowns, CSV export.
- Multi-tenant business isolation enforced at the query level (not just the UI) across jobs, cash, messages, reports, and realtime rooms.

**Verified at this exact commit** — see §5 for the literal command output.

---

## 3. What is incomplete, simulated, or intentionally not connected

- **Courier/rider verification email — UNCONFIRMED, see the explicit warning in §9.** Do not assume this works.
- **SMS/WhatsApp**: `NOTIFICATION_PROVIDER=memory` is the coded default — Twilio integration exists in code (`packages/notifications/src/*`) but no real Twilio credentials are known to be configured anywhere this session has verified. Messages log to the in-app notification list only.
- **Payment gateways**: none. Every order is COD or manually reconciled by staff; no card/online processor is wired into checkout at all.
- **Loyverse**: not connected, not coded.
- **WooCommerce sync**: env vars exist (`WOO_*`) and a poll-based sync exists in code, but this session has not verified it is active against a real store.
- **Paid maps/geocoding**: `GOOGLE_MAPS_API_KEY` is optional and, as far as this session could verify, unset in production — `/api/health` reports `"geo":"composite"`, i.e. the offline/composite fallback, not a paid provider.
- **Realtime push for the newer non-job-scoped message threads** (admin-to-anyone, logistics↔rider — added recently): poll-only by design. Web Push itself *is* wired for job offers/alerts, just not extended to these two thread types.
- **Automatic COD archival**: no cron. Archiving a settled cash entry is always an explicit accountant click, never a dated automatic sweep.
- **Background queue**: `QUEUE_DRIVER=memory` — no Redis/BullMQ connected in production as far as this session has verified.
- **Order-form/address refinements**: referenced in an earlier spec pass without enough concrete detail to build against; not started.
- **Full messaging authorization matrix**: only two thread types exist (platform-admin↔any user, logistics-company↔its own riders). No merchant↔logistics thread, no cross-business messaging beyond those two pairs, no abuse moderation/reporting on messages, no send-retry idempotency dedup on these two thread types.
- **Per-logistics-company payout/earnings figure**: reports show job-count breakdowns by company, not a payout amount — this app only has rider pay rates, no fleet-operator payout concept.
- **Render Postgres plan**: earlier session notes flagged this as still possibly on a free/time-limited tier. **Not reconfirmed this session** — check the Render dashboard directly before relying on data persisting past any such limit.
- **`grant-platform-owner` production run**: earlier session notes flagged it as unconfirmed whether this one-time script was actually run against the real production admin account. **Not reconfirmed this session.**

---

## 4. Database / migration status

- **ORM**: Prisma. **No `prisma/migrations` directory exists in this repo** — schema changes are applied with `prisma db push` against whichever database the environment points to. This is a deliberate, long-standing convention in this project, not an oversight.
- **Schema source of truth**: `apps/api/prisma/schema.prisma` (48 models at this commit). `apps/api/prisma/schema.generated.prisma` is a build artifact (gitignored, regenerated per-provider by `apps/api/scripts/prepare-db.mjs`) — never edit it directly.
- **Local dev**: SQLite file at `apps/api/data/dev.db` (gitignored). `apps/api/scripts/prepare-db.mjs` auto-selects SQLite when `DEV_DB=1` or `DATABASE_URL` starts with `file:`, otherwise Postgres.
- **Production**: Render-managed Postgres, connected via `DATABASE_URL`. **This checkpoint did not run `prisma db push` against production and made no schema or data change to it.**
- **Safe backup**: for Postgres, use Render's own automated/point-in-time backups (check the Render dashboard's Backups tab for the database) or `pg_dump "$DATABASE_URL" > backup-$(date +%Y%m%d).sql` from a trusted machine holding the real connection string — **never commit that file**.
- **Safe restore**: `psql "$DATABASE_URL" < backup-YYYYMMDD.sql` against a *new* database first to verify, never directly against production without a fresh backup taken immediately before.
- **Never** run `prisma db push --accept-data-loss` against the production `DATABASE_URL` — the project's own `prepare-db.mjs` deliberately never passes that flag.
- Local throwaway SQLite files (`apps/api/data/*.db*`, `apps/api/data/e2e-test.db`) are gitignored and were **not** touched by this checkpoint beyond what a normal `npm run test`/`e2e` run already does in the ordinary course of verification.

---

## 5. Verification — exact results at this commit

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck --workspace apps/api --workspace apps/web` | **PASS — 0 errors** |
| Unit/integration tests | `DEV_DB=1 npx vitest run` (apps/api) | **PASS — 272 / 272**, 39 files |
| Build | `npm run build --workspace apps/api --workspace apps/web` | **PASS — clean** |
| End-to-end (serial) | `rm -f apps/api/data/e2e-test.db && cd e2e && npx playwright test --workers=1` | **34 / 35** — see below |

**The one e2e failure**: `specs/booking.spec.ts` — the address-autocomplete suggestion list times out waiting on the offline geocoding fallback under test load. Confirmed pre-existing (checked against a pre-rebuild baseline via `git stash`) and re-confirmed unrelated at every prior stage this session — not a regression introduced by this checkpoint.

**Run e2e serially, not with the default `npm run e2e` script** — the default parallel-worker mode has shown spurious extra failures this session, traced to worker contention on the one shared dev server / SQLite file / realtime hub the whole suite points at, not real regressions. `--workers=1` against a freshly-deleted `apps/api/data/e2e-test.db` is the trustworthy number.

---

## 6. Required environment variables (names only — no values here or anywhere in git)

See the fully-annotated, safe-to-commit `.env.example` at the repo root for what each one does and its default. Names only, reproduced here for a fast scan:

**Core**: `APP_ORIGIN`, `SESSION_SECRET`, `LOG_LEVEL`, `HOST`, `PORT`
**Database**: `DEV_DB`, `DATABASE_URL`
**Queue**: `QUEUE_DRIVER`, `REDIS_URL`
**Maps**: `GOOGLE_MAPS_API_KEY`, `JAMNAV_API_KEY`, `JAMNAV_ENABLED`
**SMS/WhatsApp**: `NOTIFICATION_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_SMS_FROM`
**Email**: `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`
**WooCommerce**: `WOO_API_URL`, `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET`, `WOO_POLL_INTERVAL_MS`, `WOO_CURRENCY`
**Business/currency**: `OPERATIONAL_CURRENCY`, `USD_TO_JMD_RATE`
**Delivery**: `PIN_LENGTH`, `TRACKING_LINK_TTL_HOURS`, `LOCATION_RETENTION_HOURS`
**Web**: `WEB_DIST`, `MAX_UPLOAD_BYTES`
**Rate limiting**: `RATE_LIMIT_MAX`
**Web Push**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

Every one of these is validated at boot in `apps/api/src/config.ts` — an invalid/missing required value fails the process at startup rather than running half-configured. **`DEV_DB` in particular defaults to true/SQLite if left unset** — production must set it explicitly to `0` or `false`.

This session has **not** retrieved or verified the actual values currently set on Render — only that the app was responding healthy at the live URL as of this checkpoint (see §7).

---

## 7. Render deployment status

- **Live URL**: `https://orders.ronmacraedistributions.com`
- **Health check at time of this checkpoint**: `GET /api/health` returned `{"ok":true,"service":"ronmacrae-dispatch-api","queue":"memory","notifications":"memory","geo":"composite","web":true}` — process is up, using the memory queue/notification providers and the offline geo fallback.
- **Runtime**: Node (not Docker) on Render, per earlier session notes. No `render.yaml` exists in this repo — all Render configuration (build/start commands, env vars) lives only in the Render dashboard, outside this repo's control.
- **Build command** (per earlier session notes, not re-verified against the live dashboard this session): `npm install && npm run build`
- **Start command** (per earlier session notes, not re-verified against the live dashboard this session): `node apps/api/scripts/prepare-db.mjs && node apps/api/dist/main.js`
- **Known/possible production blockers**:
  1. **Courier verification email not arriving** — the reason for this checkpoint; see §9. Not diagnosed yet.
  2. **Render Postgres plan** — flagged in earlier session notes as possibly still on a free/time-limited tier. Not reconfirmed this session — check directly.
  3. **`grant-platform-owner` one-time script** — flagged in earlier session notes as unconfirmed whether it was ever run for the real production admin. Not reconfirmed this session.

This checkpoint made **no change** to the Render deployment, its environment variables, or its database.

---

## 8. Next steps for whoever picks this up

1. Read §9 below before touching the email code.
2. Diagnose the courier verification email issue end-to-end (application → code generation → provider call → provider response → sender/domain verification → production env vars → logs → spam → resend/expiry) using real provider evidence, not assumption. Do not claim it's fixed without that evidence.
3. Confirm the two "possible production blockers" in §7 (Postgres plan, `grant-platform-owner`) directly against the Render dashboard/database rather than trusting earlier notes.
4. Only after the above: proceed with the Rider→Courier rename, shared sign-up with a Merchant Business option, Courier business-access scoping, and the theme switcher, as separately scoped — each with its own tests before being called done.
5. Keep following this repo's existing conventions: `prisma db push` (no migrations dir), business isolation checked at the query level, one shared login with per-role token types, `--workers=1` for any e2e run, and a real commit + doc update after each verified stage — not before.

---

## 9. ⚠️ Explicit warning: the courier verification email issue must be diagnosed, not assumed fixed

**As of this checkpoint, nothing about the verification-email path has been changed, tested against a real inbox, or confirmed working.** This section records only what a first read of the code shows — facts about the code, not a diagnosis of the live failure, and not a fix.

- The relevant code path is `RidersService.selfSignup()` / `.resendVerification()` / `.verifyEmail()` in `apps/api/src/modules/riders.ts`, calling `sendEmailCode()` in `apps/api/src/modules/customer-account.ts`, which calls `ctx.email.send()` (`packages/notifications/src/email.ts`).
- **`sendEmailCode()` does not check or log the result of `ctx.email.send()`.** `EmailProvider.send()` is designed to *never throw* — every failure path (missing API key, missing `EMAIL_FROM`, a non-2xx HTTP response from Resend, a network error) returns `{ status: "failed", error: "..." }` instead of throwing. Because the caller discards that return value, **a real send failure currently produces no error, no log line, and no different response to the applicant** — the signup call succeeds and tells the applicant to check their email regardless of whether an email was ever actually attempted successfully.
- This is a concrete, code-level fact established by reading the source. It is a *plausible* explanation for "the email isn't arriving," but it is **not confirmed** to be the actual cause in production — the actual cause could equally be an unverified sending domain, a wrong/expired `RESEND_API_KEY`, `EMAIL_FROM` not on a Resend-verified domain, provider-side rate limiting, or the email landing in spam. All of these must be checked with real provider evidence (Resend's own dashboard/delivery logs, a real test inbox) before anything is called fixed.
- A source-code comment in `packages/notifications/src/email.ts` states "No live credentials exist in this environment, so this has never sent a real email" — **this comment's accuracy in production is unverified this session.** Earlier session notes (from a prior context) asserted a real Resend key was configured in Render; this checkpoint did not independently confirm that against the live dashboard. Do not trust either claim without checking Render's actual environment variables directly.
- **Do not** mark this resolved based on code review alone, based on the memory provider's local log output, or based on "it should work now" — only a real delivered (or provider-confirmed-sent) email to a real inbox, or explicit provider-dashboard evidence, counts as confirmation.
- **Do not** expose verification codes in browser devtools, API responses, logs, or any admin screen while diagnosing this — read them from the real inbox or, for local/dev debugging only, from the memory provider's own dev-only log line, never from a production surface a user or attacker could reach.

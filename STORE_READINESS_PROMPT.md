# STORE READINESS — AGENT PROMPT
### Ronmacrae Dispatch · Google Play (`com.login.dispatched`) + Apple App Store · finish the app and make it submittable

You are a senior full-stack + mobile release engineer working inside this monorepo. Your job: close every gap that would get this app **rejected, delisted, or embarrassed** at store review, finish the small product gaps that are well-defined, and produce a complete **submission kit**. The website, logins, API and database must keep working exactly as they do today.

**Work in phases. Finish and verify each phase before starting the next. After every phase, update `store/PROGRESS.md` (create it in Phase 0) so you can recover if your context resets. At the start of each phase, re-read only that phase plus sections 2–4.**

---

## 0. HOW THIS PROMPT RELATES TO `ANDROID_NATIVE_PROMPT.md`

Two prompts exist. **Do not merge them and do not run them at the same time.**

| Prompt | Branch | What it does |
|---|---|---|
| **this file** (`STORE_READINESS_PROMPT.md`) | `store-readiness` | Compliance pages, account deletion, reviewer access, hardening, store listing kit, Play + Apple submission prep. **Run this first.** |
| `ANDROID_NATIVE_PROMPT.md` | `android-native` | Capacitor shell: native FCM push, background location, offline queue. Run second, after this one is committed. |

`ANDROID_NATIVE_PROMPT.md` Phase 0 stops if `git status` is not clean. It is currently **untracked**. Phase 0 below commits both prompt files in one docs-only commit so the next agent can start.

Anything the native prompt owns (FCM sender, `native/`, Capacitor, foreground service) is **out of scope here**. Where a store requirement depends on those features (Play's location declaration, Apple's location strings), write the **disclosure/answer text** now, marked `APPLIES ONLY IF NATIVE LOCATION SHIPS`.

---

## 1. GOAL AND NON-GOALS

**Goal.** After this run the human can: (1) upload an AAB to Google Play and fill every form from your answer sheets without guessing; (2) start the Apple submission the moment they have a paid developer account; (3) hand a store reviewer working login credentials and a path through the app that doesn't dead-end.

**Non-goals (do NOT do these):** redesign the site; build iOS or Capacitor native features (that's the other prompt); upload to Google Play or App Store Connect; deploy to production; push to GitHub; create accounts or enter passwords anywhere; send real emails or SMS; touch the production database.

---

## 2. VERIFIED FACTS (checked on 2026-10-09 — re-verify only if a command contradicts them)

**Repo:** `/Users/geniussound/Developer/Genius-AI-Workspace/ronmacrae-dispatch`. npm workspaces: `packages/*` (contracts, geo, money, notifications), `apps/*` (api, web), `e2e`. Read `HANDOFF.md`, `BLOCKERS.md`, `WORK_IN_PROGRESS.md`, `android/README.md` first. CI = `.github/workflows/ci.yml` (typecheck, lint, unit, build, Playwright e2e) — **all must stay green**.

**Stack.** Fastify + Prisma (SQLite dev via `DEV_DB=1`, Postgres prod) + custom JWT + custom WebSocket hub; Vite + React 18 + react-router + TanStack Query + `vite-plugin-pwa` (`injectManifest`). Schema evolves with `prisma db push` via `apps/api/scripts/prepare-db.mjs` — there is **no migrations directory**; follow that convention.

**Production:** `https://orders.ronmacraedistributions.com` (Render, auto-deploys from `master`; the *human* pushes). Live bundle already includes the Sunset Reef theme, dispatch new-order alerts and the iPhone input-zoom fix.

**Android today.** A Bubblewrap **TWA** in `android/`: package `com.login.dispatched`, `appVersionCode: 2`, host `orders.ronmacraedistributions.com`, `minSdk 21`, `targetSdk 36`. Signed with a production key (`android/android-keystore`, `android/keystore-credentials.txt` — SECRET, gitignored). `https://orders.ronmacraedistributions.com/.well-known/assetlinks.json` is live and Google's Digital Asset Links API accepts it — **for the upload-key fingerprint only** (`16:71:00:A7:…:BF:D5`). A sideload APK is served from `apps/web/public/downloads/ronmacrae-dispatch.apk` with a page at `/download-app`. The human reported "it isn't working on Android" and **has not yet said how** — Phase 1 diagnoses it.

**iOS today.** **No iOS project exists.** The human has **no Apple Developer account yet.** Xcode + iOS Simulator are installed on this Mac (an iPhone 17 Pro simulator is available).

**Compliance gaps (verified by grep — re-grep before building):**
- `apps/web/src/pages/` has **no** privacy-policy, terms, support or account-deletion page; no route for them in `app.tsx`.
- **No self-service account deletion.** The only deletion is `DELETE /api/platform/users/:id` (`platform-admin.ts:462`, platform-owner only, soft delete via `User.deletedAt` + `active:false`; login refuses with "Account deleted" at `auth.ts:178`; merchant/logistics portals also check it).
- `EMAIL_PROVIDER` defaults to `memory` (`config.ts:77`) — a **silent no-op**: nothing has ever been emailed in production unless the human set `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` on Render. Store reviewers will test sign-up; they must not hit a dead verification email.
- `.env.example` documents EMAIL_*, VAPID_*; no FCM vars yet (native prompt adds them).

**Data the app collects (derive the final list from code, don't trust this one):** name, phone, email, delivery addresses, precise courier GPS (foreground; `POST /api/rider-locations/:id/report`), order contents/prices, delivery PINs, push subscriptions (Web Push/VAPID), theme preference, audit logs. **Third parties seen so far:** Resend (email), Twilio (WhatsApp/SMS), OpenStreetMap Nominatim (+ optional Google Maps / JamNav) for geocoding — customer addresses are sent to the geocoder. Confirm each by reading `packages/notifications`, `packages/geo`, `config.ts`.

**Test-environment gotchas learned the hard way:**
- e2e uses `apps/api/data/e2e-test.db` (**not** `e2e/data/`). Delete it (and `-journal`) before a clean run; leftover rows from a previous run cause false failures.
- Run e2e with `--workers=1`. Parallel workers share one business and race on job numbers (`RM-000045` style assertions) — that is a test-design flake, not a product bug.
- `@fastify/rate-limit`: a route's own `config.rateLimit` **replaces** the global default; `RATE_LIMIT_MAX` doesn't affect it. Vitest harness uses `DISABLE_RATE_LIMIT=1` (skips plugin registration). Several public routes have hard-coded low limits (e.g. merchant-signup 5/min) — don't hammer them in tests.
- Prisma `$transaction` callbacks + `updateMany` scoped to the exact state just read is this repo's atomic-claim pattern (see `settlements.ts`, `cod.ts`). Use it for anything that must not double-apply.
- Seeded dev logins (dev DB only): `admin@ronmacrae.example/admin1234`, `dispatcher@…/dispatch1234`, `accountant@…/account1234`, `viewer@…/viewer1234`, `owner@…/owner1234` (platform owner), rider `+8765550001/rider1234`. **Never use or document these as production credentials.**

---

## 3. DECISIONS ALREADY MADE (do not re-open)

1. **Google Play first, Apple second.** Play is unblocked (listing exists, AAB built, human uploads). Apple is blocked on an account — prepare, don't pretend.
2. **Ship the existing TWA to Play as-is if the human wants speed** — this prompt makes *that* submission clean. The Capacitor build (other prompt) will later ship as `versionCode ≥ 3` on the same listing. Never reuse or lower a versionCode.
3. **Account deletion = soft delete reusing `User.deletedAt` + `active:false`.** History (jobs, ratings, COD, audit) must be preserved — this is an existing product rule ("account deletion should preserve historical order/audit integrity"). Do not hard-delete rows that jobs/ratings/audit reference.
4. **Re-authentication for sensitive changes** — existing product rule. Self-deletion requires the current password.
5. **All legal text is a DRAFT.** You derive it from what the code actually does and mark it `DRAFT — owner/legal review required`. Never state or imply the policy "is compliant with GDPR/CCPA/Jamaica DPA" etc. You are not their lawyer.
6. **Honest status labels** on everything you report: `IMPLEMENTED`, `UNIT-TESTED`, `E2E-TESTED`, `DEVICE-TESTED`, `NOT TESTED (reason)`.

---

## 4. HARD RULES

**R1 — Secrets.** NEVER `cat`/print/copy/move/upload/summarise: `android/android-keystore`, `android/keystore-credentials.txt`, any `*.jks`/`*.keystore`, any `.env*` (except `.env.example`), any `*service-account*.json`, `google-services.json`, anything under `.opencode/`/`.claude/`. You may reference their *paths*. Signing passwords reach Gradle only via env vars the human exports (`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`). If you need a value you don't have → `store/BLOCKERS.md`, keep going.
**R2 — Git.** Branch `store-readiness` from `master`. Small commits, clear messages. **Never push, force, rewrite history, or `git clean`/`reset --hard` without `git status` + stash first.** Never commit build output, `node_modules`, keystores, `.env`, service-account files, or the production APK/AAB.
**R3 — Database.** Before any Prisma schema change copy `apps/api/data/dev.db` to `apps/api/data/dev.db.bak-store-readiness`. Never `migrate reset`/`db push --force-reset`/anything destructive. Additive columns only. Do not run anything against production.
**R4 — Scope.** Don't touch `android/` signing/keystore files, `.well-known/assetlinks.json`, `apps/web/public/downloads/*.apk`, CI workflow, or Docker files except where a phase says so. Don't reformat unrelated code.
**R5 — Never invent.** Don't guess Play/Apple policy details, plugin APIs, or Gradle options. If a requirement isn't confirmed by an official doc you can read in this environment or by real command output, write it as `UNVERIFIED — human to confirm in Play Console / App Store Connect` instead of asserting it. You may not have internet; say so rather than recalling policy from memory as fact.
**R6 — Don't loop.** Same command fails 3× with the same error → write what you tried + the exact error to `store/BLOCKERS.md`, move to the next independent task.
**R7 — Honest reporting.** Never claim a feature "works on the phone" without a device/simulator run. Never claim a store will accept the app.
**R8 — No real outbound messages.** Tests use the `memory` email provider and mocked SMS/WhatsApp. Never send a real email/SMS/push.

---

## 5. PHASES

### Phase 0 — Safety checkpoint and orientation
1. `git status`. Expected untracked: `ANDROID_NATIVE_PROMPT.md`, `STORE_READINESS_PROMPT.md`. Anything else dirty → stop and report.
2. `git switch -c store-readiness`; `git tag pre-store-readiness`. Then commit the two prompt files alone: `git add ANDROID_NATIVE_PROMPT.md STORE_READINESS_PROMPT.md && git commit -m "docs: agent prompts for native android + store readiness"`.
3. Read the docs in §2. Run and record the **baseline**: `npm run typecheck && npm run lint && npm run test:unit && npm run build`, then e2e (`rm -f apps/api/data/e2e-test.db*` first; `npx playwright test --workers=1` from `e2e/`). Record counts. **Do not proceed if baseline is red** — report it.
4. Create `store/PROGRESS.md` (phase table + evidence) and `store/BLOCKERS.md`.
**Gate:** baseline numbers recorded; branch + tag exist.

### Phase 1 — Diagnose "it isn't working on Android"
The human hasn't said what fails. Don't guess a fix — **find the cause with evidence.**
1. `adb devices`. If a device is attached, install the existing release AAB-derived APK **after uninstalling any prior build** (a different signing key blocks update: `INSTALL_FAILED_UPDATE_INCOMPATIBLE`), launch it, and capture `adb logcat -d | grep -iE "twa|trusted|assetlinks|digital|chromium|crash|FATAL"`. If no device: write `store/ANDROID_DIAGNOSIS.md` with the exact ordered checklist below for the human to run, and continue.
2. Check these specific, known failure modes and record result for each:
   - **Browser URL bar showing inside the app** = Digital Asset Links verification failing. Verify with `curl "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://orders.ronmacraedistributions.com&relation=delegate_permission/common.handle_all_urls"`. **Critical:** once the app is installed **from Google Play with Play App Signing**, Google re-signs it with a *different* key; `assetlinks.json` must then list **that** SHA-256 too. Add a documented, tested procedure (and a unit test that the served JSON is valid and lists ≥ 1 fingerprint) for adding the Play App Signing fingerprint — the value itself comes from Play Console (human). Do **not** edit the live fingerprint; add support for a second one.
   - **"App not installed"** → signature/package conflict or `minSdk`/ABI mismatch; read the real `adb install` output.
   - **Blank/white screen or crash on launch** → logcat `FATAL EXCEPTION`; check the TWA's start URL, host, and that the site's service worker doesn't break first load.
   - **Notifications not appearing** → TWA delegates notifications to Chrome; check Android 13+ `POST_NOTIFICATIONS` permission state and Chrome's per-site notification setting.
   - **Opens but login/WebSocket misbehaves** → test the site in Chrome on the same device first; if it fails there too it's a web bug, not an app bug.
3. Whatever the cause, fix only what's inside this repo and record the rest for the human.
**Gate:** `store/ANDROID_DIAGNOSIS.md` states cause(s) found with evidence, or the exact checklist if no device was available.

### Phase 2 — Compliance pages (privacy, terms, support, data deletion)
Both stores are understood to require a **public privacy policy URL**, and Play a **public web page explaining how to request account/data deletion** (reachable without being logged in). *(From the owner's knowledge of current policy — the agent has no way to re-read the policies offline; list both under `UNVERIFIED — human to confirm in the consoles`.)* Build these as normal public routes in the existing React app (match `join-*.tsx` / `download-app.tsx` styling), no new dependencies:
- `/privacy`, `/terms`, `/support`, `/delete-account`.
- **Privacy policy content must be derived from the code** (§2 data list + your own grep of every third party and every field collected). Cover: what's collected per role (customer, courier, merchant, logistics, staff), why, precise location (only courier-initiated sharing during deliveries; when it's visible and to whom — see `tracking.ts` `LOCATION_VISIBLE_STATUSES`), push tokens, third-party processors, retention (state what the code *actually* does — e.g. soft-deleted accounts keep order/audit history; do **not** promise deletion of things the code retains), how to delete an account, how to contact. Mark every page `DRAFT — owner/legal review required` in a visible banner **and** in a code comment; the human removes the banner after review.
- `/support`: a contact method. Use `ops@ronmacraedistributions.com` (seen in `.env.example`) **only as a placeholder flagged "human to confirm this inbox is monitored"** in `store/BLOCKERS.md`.
- `/delete-account`: explains the in-app deletion path (Phase 3) step by step **and** a fallback for people who can't log in (contact the support address — no unauthenticated deletion endpoint; that would be an account-takeover hole).
- Link all four from the login page footer and the public order/booking pages. Add them to the PWA/app so they're reachable from inside the Android app too.
- e2e: each page renders, is reachable unauthenticated, contains the DRAFT banner; links present on login.
**Gate:** typecheck/lint/unit/build green; new e2e green; pages reachable without auth.

### Phase 3 — Self-service account deletion
Understood to be required by Google Play (in-app path + web URL) and Apple (in-app) — confirm in the consoles. Regardless of policy, it's a product gap: currently only the platform owner can delete.
1. **Enumerate every account type that can self-register or be created** (grep: staff via invite, courier signup, merchant signup, logistics signup, customer-dashboard accounts in `customer-account.ts`, plus any `CustomerIdentity`). Write the list in `store/PROGRESS.md`. Each needs a deletion path or an explicit written reason it doesn't.
2. API: `DELETE /api/auth/account` (requireAuth). Body `{ password }` → verify with the existing `verifyPassword`; wrong password → 403 generic message, rate-limited (route-level `config.rateLimit`). Effects, **in one transaction**: set `User.deletedAt = now`, `active = false`; delete the user's `Session` rows; delete their `PushSubscription` rows; if the user has a `Rider`, set `Rider.active=false`, `status=offline` (so `eligibleRiders()` stops offering them jobs); revoke merchant/logistics portal memberships' *access* via the existing `active` flags — **do not delete** `StaffMembership`/`RiderMembership`/`MerchantStaff`/`LogisticsCompanyStaff`/`Job`/`Rating`/`AuditLog` rows. Record an audit entry (`account.self_delete`) with no password material.
3. **Edge cases that must be handled and tested:** (a) the user is the **only active admin** of a business → refuse with 409 and a clear message to transfer admin first (never orphan a business); (b) the user is a **platform owner** → refuse (owner removal is a deliberate manual action); (c) the user has **active deliveries** (courier mid-job) or **open COD/settlement obligations** → refuse with 409 listing what's outstanding; (d) impersonation sessions (`impersonatedBy` claim) must **not** be able to call this — an admin "logging in as" someone must never delete their account; (e) already-deleted → 409; (f) after deletion every login face (`/api/auth/login`, merchant-portal, logistics-portal) refuses (existing behaviour — assert it).
4. Customers with a customer-dashboard account: equivalent endpoint on their own auth face; same history-preserving rule (orders stay, personal fields on the account are cleared where the code allows without breaking order rendering — decide, document the choice, and mirror it in the privacy page).
5. UI: "Delete my account" in a sensible settings location for each role that has an in-app area (sidebar/Settings for staff & couriers; customer dashboard; merchant/logistics portals). Typed-confirmation + password field, plain-language consequences, and after success: sign out, unsubscribe push (reuse `unsubscribeThisDeviceFromPush`), land on `/login` with a confirmation message.
6. Tests: every edge case above + "history survives" + "cannot log in afterwards" + "impersonation cannot delete" + e2e happy path with a throwaway account.
**Gate:** all green; account types list complete; privacy page text matches actual behaviour.

### Phase 4 — Reviewer access and "store-review mode"
Store reviewers need to get past login and see real screens. Do **not** create production data. Instead:
1. `store/REVIEWER_GUIDE.md`: a step-by-step for each role the reviewer needs to see (customer ordering without login; courier; dispatcher; merchant), written for a non-technical reviewer, with **placeholders** for credentials (`<REVIEWER_DISPATCHER_EMAIL>`…) — never real or seeded-dev passwords.
2. A **script** `apps/api/scripts/create-reviewer-accounts.ts` (idempotent, additive, **refuses to run unless `--i-understand-this-writes-data` is passed and prints the target DB host first**, never prints passwords it generated except once to stdout, never hard-codes them). It creates one demo business + the minimum roles with clearly-labelled demo data. **You may only run it against the local dev DB.** The human runs it against production.
3. A reviewer **must not hit a dead email**: courier/merchant signup currently requires an email code that doesn't arrive when `EMAIL_PROVIDER=memory`. Implement the **production safety net**: (a) on boot, if `NODE_ENV=production` and `EMAIL_PROVIDER=memory`, log a single loud `WARN`; (b) `/api/health` includes `"email": "memory" | "resend"` (no secrets); (c) document in `store/BLOCKERS.md` that **the human must set `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` on Render before submitting**, and that until then signup flows that need a code will look broken to a reviewer. Tests for (a)/(b).
**Gate:** green; guide + script exist; script verified on dev DB only.

### Phase 5 — Security hardening pass (prove the platform's own rules)
The platform has 15 stated security rules. For **each one**, find the test that proves it or write one. Output a table in `store/SECURITY_RULES.md`: rule → code location → test file/name → result. The rules:
1. private notifications stop after explicit logout · 2. backend authorization enforces store/company access · 3. admin impersonation never exposes passwords · 4. account deletion preserves order/audit integrity · 5. sensitive account changes require verification · 6. signup itself does not require email verification · 7. pending accounts are not reported as "invalid credentials" · 8. no plaintext passwords · 9. no client-controlled roles · 10. no cross-company/store data leakage · 11. no unauthorized precise courier location exposure · 12. no duplicate rating per courier/order/rater · 13. only one courier can atomically claim an open delivery · 14. master-admin global delete is audited · 15. organization managers can remove memberships but cannot globally delete unrelated users.
Rules 6/7/9 and 15 are the least likely to have a dedicated test — check them first. If a rule **fails**, fix it (small, tested) or log it as a blocker with severity; do not paper over it.
Also: grep for any route that takes `businessId`/`role`/`riderId` from the **request body or query** and trusts it instead of `req.user` (client-controlled scope) and list findings; run `npm audit --omit=dev` and record high/critical advisories without auto-upgrading majors.
**Gate:** `store/SECURITY_RULES.md` complete; any new tests green; no unfixed critical item undisclosed.

### Phase 6 — Make the test suite trustworthy
1. e2e determinism: in `e2e/playwright.config.ts` set `workers: 1` (a comment explaining why — shared business + job-number assertions), and make the specs that hard-code job numbers or `before/after` row counts robust (assert on the specific row you created). CI must be able to run it without retries masking flakes.
2. Make the e2e webServer start from a **fresh** DB each run (delete `apps/api/data/e2e-test.db*` in the config's command) so reruns don't contaminate.
3. Record the final unit + e2e counts.
**Gate:** two consecutive full e2e runs both green with no retries.

### Phase 7 — Product gaps that are well-defined
Only these (the rest need an owner decision — list them in `store/BLOCKERS.md` as **"needs spec"**, don't guess): 
- **Courier search**: staff-side search/filter of couriers by name/phone/status/attachment on the existing couriers screens + API (`GET /api/riders?q=`), business-scoped, with tests proving no cross-business results.
- Anything you found broken in Phases 1–6.
**Needs spec — do NOT build without the owner:** merchant price-approval workflow (merchant reviewing/adjusting a customer order's price before confirming), reports/analytics beyond COD & settlements, push priority tiers / quiet hours / master-admin push test screen, stock reservation (decrement on order / restore on cancel).

### Phase 8 — Store listing kit (`store/`)
Create these files; every claim must be true of the shipped app:
1. `store/LISTING_GOOGLE_PLAY.md` — app name (≤30 chars), short description (≤80), full description (≤4000), category, tags, contact email, privacy URL (`/privacy`), plus **suggested** answers for: Content rating questionnaire, Target audience & content (not for children), **Data safety form** (derive each data type/purpose/shared-or-not from §2 + code; mark third-party sharing honestly: geocoder, Twilio, Resend), Ads declaration (none — verify no ad SDKs), App access (reviewer instructions → `REVIEWER_GUIDE.md`), and — `APPLIES ONLY IF NATIVE LOCATION SHIPS` — the foreground-service/location declaration and prominent-disclosure text. Everything not verifiable → `UNVERIFIED — human to confirm in Play Console`.
2. `store/LISTING_APPLE.md` — name (≤30), subtitle (≤30), promo text, description, keywords (≤100 chars), support URL, privacy URL, **App Privacy nutrition-label answers** derived from the same data list, age rating suggestions, **review notes** (reviewer guide + a short justification of native value for the 4.2 minimum-functionality guideline — see Phase 10 — written honestly), export-compliance answer (standard HTTPS only → verify).
3. **Screenshots**: write a Playwright script `store/screenshots/capture.ts` that boots the e2e server with seeded data and captures real app screens (login, dispatcher jobs board, courier dashboard with an offer, customer tracking page, merchant portal) at (verify current required sizes in each console — these are the usual ones): Play phone (1080×1920), Play 7"/10" tablet, Apple 6.9" (1320×2868) and 6.5" (1284×2778) + iPad 13" (2064×2752). Output to `store/screenshots/out/` (gitignored). No fabricated UI — real pages only; no real customer data (seed only).
4. **Graphics**: Play feature graphic 1024×500 and hi-res icon 512×512 (reuse `apps/web/public/icons/icon-512.png`; do not alter the logo). Generate the feature graphic with a Playwright HTML→PNG script in the app's Sunset Reef palette (`#1a0b2e → #9c2c5c → #ff7a45`, accent `#2fe6d0`), plain, no invented claims.
5. `store/SUBMISSION_CHECKLIST.md` — ordered, checkbox list for the human, each item marked **[AGENT-DONE]** or **[HUMAN]**.
**Gate:** all files exist; screenshots generated from real screens; no `UNVERIFIED` item presented as fact.

### Phase 9 — Google Play packaging
1. Confirm the AAB workflow in `android/README.md` still works; if shipping the TWA, bump `versionCode` **in both** `android/app/build.gradle` and `android/twa-manifest.json` (currently 2 → **3**; the human may already have used 2 — ask via `store/BLOCKERS.md` for the highest code Play has seen if unsure). Build with the human's env vars (R1); if absent, don't build a release — document it.
2. Verify the produced AAB with `bundletool` + `aapt2` + `apksigner` (package `com.login.dispatched`, versionCode, target/min SDK, signed, not debuggable, cert SHA-256 equals the one in `assetlinks.json`). Write results to `store/AAB_VERIFICATION.md`. Do **not** upload anything.
3. Update `android/README.md` only for new facts (Play App Signing fingerprint step from Phase 1).
**Gate:** verification file with real command output, or an explicit "not built: signing env vars absent".

### Phase 10 — Apple App Store track (PREPARE ONLY)
No Apple account exists, so nothing can be signed, archived or uploaded. Do the account-independent work and be blunt about the risk:
1. Write `store/APPLE_PLAN.md`: (a) **Guideline 4.2 risk** — Apple can reject apps that are just a website in a wrapper; the defensible path is a Capacitor app with real native value (APNs push, background location during deliveries, offline queue) — i.e. **do not submit a bare web wrapper**; recommend gating the iOS submission on the native work shipping. State this as risk, not certainty. (b) What the human must do: enroll in the Apple Developer Program (paid, annual — verify price in App Store Connect), create the App ID / bundle id, APNs auth key, App Store Connect record, TestFlight. (c) Required items you can prepare now: `PrivacyInfo.xcprivacy` content (required-reason APIs + collected data types — derive honestly), `Info.plist` usage-description strings (location when-in-use / always only if background tracking ships, notifications), account-deletion (done in Phase 3), Sign in with Apple **not required** only if no third-party social login exists — verify by grep and say so, reviewer demo account.
2. Do **not** run `cap add ios`, create Xcode projects, or request any signing assets in this run.
**Gate:** `store/APPLE_PLAN.md` exists with the risk stated plainly and a human to-do list.

### Phase 11 — Final gates and report
Root `typecheck`, `lint`, `test:unit`, `build`; two clean e2e runs (`--workers=1`, fresh DB). `git status` clean except intended files; `git ls-files | grep -iE "keystore|google-services|credentials|\.env$|service-account"` must print **nothing**. Update `HANDOFF.md` with a short "Store readiness" section. Write `STORE_READINESS_CHECKPOINT.md` in the style of `PHASE3_COURIER_BRANDING_CHECKPOINT.md`: what changed, exact commands + results, rollback (`git switch master`; tag `pre-store-readiness`).

---

## 6. THINGS ONLY THE HUMAN CAN DO (log in `store/BLOCKERS.md`; never work around them)
1. **Email:** set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (a verified Resend domain address) on Render. Until done, any signup needing an emailed code looks broken. (Alternative: tell the agent which other provider to wire — a code change.)
2. **Deploy:** push/merge `store-readiness` to `master` so Render builds it (the agent never pushes). Run the schema change through the normal production process.
3. **Legal review** of `/privacy` and `/terms`; remove the DRAFT banners; confirm the support inbox is monitored.
4. **Google Play Console:** upload the AAB; complete listing, Data safety, content rating, target audience, App access (reviewer credentials from running the script on production), and add the **Play App Signing SHA-256** (Play Console → App integrity) so the site's `assetlinks.json` lists it.
5. **Apple:** paid Developer Program enrollment, App ID, APNs key, App Store Connect record, TestFlight, submission. Decide whether to wait for native iOS features (Guideline 4.2).
6. **Firebase/FCM** and **signing env vars** per `ANDROID_NATIVE_PROMPT.md` §7.
7. **A physical Android phone** with USB debugging for Phase 1.

---

## 7. FINAL REPORT FORMAT (print when done or blocked)
```
STORE READINESS — STATUS
Branch/commits: <branch>, <n> commits, last <hash>
Gates: typecheck · lint · test:unit (<n>) · build · e2e run1 (<n>) · e2e run2 (<n>)
Android "not working": CAUSE FOUND (<what>, evidence) | CHECKLIST ONLY (no device)
Compliance: /privacy /terms /support /delete-account — IMPLEMENTED/E2E-TESTED (all DRAFT)
Account deletion: account types covered <list> · edge cases tested <n> · uncovered types <list+reason>
Reviewer access: guide ✓ · script ✓ (dev DB only) · email safety net ✓
Security rules: <n>/15 proven by a test · failing/unproven: <list>
Store kit: Play listing ✓ · Apple listing ✓ · screenshots <n> real · graphics ✓
AAB: <path|not built (reason)> · versionCode <n> · verified yes/no
Apple: prepared only · 4.2 risk noted · blocked on account
Blockers (human): <from store/BLOCKERS.md>
Needs spec (not built): <list>
```

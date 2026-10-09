# Android Native Checkpoint — Capacitor rider shell (2026-10-09)

**Status: Phases 0–6 + 8 done, all automated gates green. Phase 7 skipped
by design. Nothing is DEVICE-TESTED (no phone attached) and nothing was
submitted anywhere — Play Console work is entirely human (see §6).**

Branch: `android-native` (from `master` 7283daf). Recovery tag:
`pre-android-native`. Rollback: `git switch master` (the tag marks the
exact pre-work state; this branch was never pushed).

The narrative record is `native/PROGRESS.md` (per-phase evidence) and
`native/BLOCKERS.md` (human-only items). `HANDOFF.md`, `store/` docs, and
the TWA in `android/` are untouched — the TWA stays as-is until the human
decides to retire it.

## 1. What was built (honest status per feature)

- **Capacitor shell** (`native/`, appId `com.login.dispatched`,
  versionCode/versionName 3): loads the live site, navigation locked to
  the production host, cleartext + mixed content off, brand colours/icons
  copied from the TWA, release signing via env vars only (release tasks
  fail fast with a clear message without them — verified). Merged
  permissions: INTERNET, COARSE/FINE_LOCATION, FOREGROUND_SERVICE
  (+_LOCATION), POST_NOTIFICATIONS, WAKE_LOCK, ACCESS_NETWORK_STATE
  (FCM), c2dm RECEIVE. Stripped: SCHEDULE_EXACT_ALARM,
  RECEIVE_BOOT_COMPLETED. No ACCESS_BACKGROUND_LOCATION. IMPLEMENTED +
  debug-built; install/loads-site NOT device-tested.
- **Push (FCM)**: `DevicePushToken` model + register/unregister routes
  (auth, zod, 60/min, ownership-scoped; re-register moves the token);
  hand-rolled FCM HTTP v1 sender (no firebase-admin); HIGH priority,
  job_offers/messages channels, collapse/tag reuse, dead-token pruning,
  Web Push de-dupe (recent native token + successful send suppresses the
  duplicate; FCM failure falls back to Web Push); logout sweep
  server-side + device unregister client-side; loud bundled
  `offer_alert.wav`; tap → deep link incl. cold start; `/api/health`
  reports `nativePush`. UNIT-TESTED (14 API + client tests). Needs
  Firebase + device for the real wake-the-phone proof.
- **Background location**: foreground-service watcher, starts ONLY after
  the prominent disclosure AND with an active delivery; same report path
  (8 s, clientSeq, `paused` on stop — API unchanged); auto-stop on
  delivery end/logout; killed-service honesty (tap-to-resume, never
  faked); one-time battery hint; privacy policy + Data Safety draft
  updated. UNIT-TESTED. The 5-minute locked-screen proof needs a phone.
- **Offline resilience**: last-known jobs/offers cache (age-labelled,
  offline-only) + persistent idempotent action queue (accept/collect/
  deliver; server `IdempotencyKey` on the 3 rider mutations; deliver
  stays pending until confirmed; rejections surfaced with Retry/Dismiss).
  UNIT-TESTED. Cold-start-offline in a WebView is expected-after-one-
  visit but unverified (recorded limitation, not a bundled build).
- **Lock-screen Accept/Decline buttons**: SKIPPED with a design note in
  PROGRESS.md (needs data-message path + Firebase + device; the loud
  channel + tap-to-open already cover waking).

## 2. Exact test commands + results (this machine, 2026-10-09)

- `npm run typecheck` — PASS, 0 errors (all workspaces).
- `npm run lint` — PASS, 0 errors.
- API vitest: **50 files, 377/377** (358 baseline + 14 push-native + 5 idempotency).
- Web vitest: **11 files, 53/53** (20 baseline + 19 bridge + 6 queue + 2 cache + 6 location/push additions).
- `npm run build` — PASS (web main chunk +8 kB of adapters/components;
  zero "capacitor" strings in the eager entry; plugin code in lazy chunks
  only — see PROGRESS.md Phase 3).
- e2e serial (`--workers=1`, fresh `e2e-test.db`):
  rider-dashboard + offers 3/3 during Phase 6; FULL suite below in §5.
- `npx cap doctor` — "Android looking great".
- `assembleDebug` + `bundleDebug` — BUILD SUCCESSFUL (JDK 21 required).
- `bundleRelease` without signing vars — fails fast with the documented
  message (verified, no passwords sought).
- AAB/APK inspection (`aapt dump badging`): package
  `com.login.dispatched`, versionCode 3, minSdk 24 / targetSdk 36, the 10
  permissions above, bundled `server.url` + single-host allowNavigation.
- `git ls-files | grep -i -E "keystore|google-services|credentials|\.env"`
  — empty. No secrets in the repo.

## 3. DEVICE-TESTED vs not

- DEVICE-TESTED: nothing (no phone attached during this pass).
- UNIT-TESTED: everything above.
- Follow `native/DEVICE_TEST.md` sections A (location, no Firebase
  needed), B (push, needs Firebase), C (offline queue) with a phone.

## 4. Known limitations

1. No custom small push icon (default app icon used; may render flat —
   needs a white-on-transparent asset + manifest meta-data).
2. Cold-start-offline in the WebView unverified (see §1).
3. Native features only work after the human deploys the API + web
   (the shell loads the LIVE site).
4. `ACCESS_BACKGROUND_LOCATION` deliberately absent — if the device test
   proves the service dies without it, that goes to BLOCKERS with logs,
   never in silently (Play declaration + demo video required).
5. A deleted/disabled account's 15-minute token still works until expiry
   (pre-existing, low).

## 5. Final full gates (run at checkpoint time)

- `npm run typecheck` PASS · `npm run lint` PASS (0 errors) ·
  `test:unit` API 377/377 + web 53/53 + contracts/geo/money/notifications
  green · `npm run build` PASS.
- `npm run e2e` serial (`--workers=1`, fresh `e2e-test.db`): **50/50**.

## 6. Play Console to-do (human only — none of this was attempted)

1. Firebase project + `google-services.json` + service account;
   `FCM_PROJECT_ID`/`FCM_SERVICE_ACCOUNT_PATH` on production.
2. Export the 4 signing vars; `./gradlew bundleRelease`; upload the AAB
   (existing `android/upload-release.mjs` works with a service-account
   JSON) — internal track first.
3. Data safety form (location background wording is ready in
   `store/LISTING.md`), foreground-service/location declaration if
   prompted, privacy policy (updated in `legal.tsx`, still DRAFT-bannered
   pending legal review), app-signing SHA-256 → `assetlinks.json`.
4. Deploy API + web (Prisma change is additive: `DevicePushToken`,
   `IdempotencyKey`).
5. Physical-device pass of `native/DEVICE_TEST.md`.
6. Decide TWA retirement (`android/`, public APK download).

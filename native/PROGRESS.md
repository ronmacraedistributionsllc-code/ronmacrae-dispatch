# Android Native — Progress

Branch: `android-native` · tag: `pre-android-native` (from `master` 7283daf).
Goal: Capacitor shell (`native/`) wrapping https://orders.ronmacraedistributions.com + rider-only native push, background location, offline resilience. No Play submission in this pass.

## Phase table

| Phase | Status | Evidence |
|---|---|---|
| 0 Safety checkpoint + orientation | done | Branch `android-native`, tag `pre-android-native`; baseline below |
| 1 Toolchain check | done | `npx cap doctor`: "Android looking great" (see below) |
| 2 Capacitor shell scaffold | done | `assembleDebug` BUILD SUCCESSFUL; APK installs/loads live site: NOT TESTED (no device) |
| 3 Web-side native bridge | done | typecheck/lint/test:unit/build green; bundle evidence below |
| 4 Native push (FCM) end-to-end | done (UNIT-TESTED; device test blocked on Firebase) | API + client below; debug build green with and without google-services.json |
| 5 Background location | done (UNIT-TESTED; device test pending a phone) | disclosure + gating + battery hint + DEVICE_TEST.md; e2e rider-dashboard green |
| 6 Offline resilience | done (UNIT-TESTED; device part in DEVICE_TEST.md) | audit + Network extension + cache + idempotent queue; e2e rider-dashboard/offers green |
| 7 Lock-screen actions (stretch) | skipped | see note below |
| 4 Native push (FCM) end-to-end | not started | blocked on Firebase project (human) for device test |
| 5 Background location | not started | needs device (human) |
| 6 Offline resilience | not started | — |
| 7 Lock-screen actions (stretch) | not started | only if 4–6 green |
| 8 Build, sign, document | not started | unsigned/debug only until human supplies signing env vars |

## Baseline (Phase 0, 2026-10-09, Apple silicon, Node v26.8.1)

- `npm run typecheck` — PASS, 0 errors (all workspaces).
- `npm run lint` — PASS, 0 errors.
- Unit tests (vitest, per workspace):
  - `@ronmacrae/api`: 48 files, 358/358 PASS.
  - `@ronmacrae/web`: 4 files, 20/20 PASS.
  - `@ronmacrae/contracts`: 8/8 PASS.
  - `@ronmacrae/geo`: 21/21 PASS.
  - `@ronmacrae/money`: 8/8 PASS.
  - `@ronmacrae/notifications`: 7/7 PASS.
- `npm run build` — PASS (all workspaces; web PWA precache 23 entries).
- e2e (Playwright): NOT RUN in this baseline (runs serially with `--workers=1` per HANDOFF; will run at final gate if environment supports it).

## Phase 1 — toolchain (done)

- `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home` — JDK 21 is REQUIRED, not 17: `@capacitor/local-notifications` demands a Java 21 toolchain (`languageVersion=21`); the build fails on JDK 17. (Gradle 8.14.3 + AGP 8.13.0 run fine on 21.)
- SDK: `~/Library/Android/sdk` (platforms android-33..37, build-tools 34/35/36) via `ANDROID_HOME`/`ANDROID_SDK_ROOT`. Template needs compile/target SDK 36 — present, no `sdkmanager` installs needed.
- `adb devices`: daemon runs, **no device attached** — Phase 5/8 device tests pending a human-plugged phone (preferred); emulator creation needs approval (R7).
- `npx cap doctor` (from `native/`): "Android looking great".

## Phase 2 — Capacitor shell (done)

- `native/package.json` (private, NOT in root workspaces): core/cli/android 8.5.3, push-notifications 8.1.3, local-notifications 8.3.1, network 8.0.1, app 8.1.2, preferences 8.0.1, browser 8.0.5, background-geolocation 1.2.26.
- `capacitor.config.ts`: appId `com.login.dispatched`, `server.url` live site, `cleartext:false`, `allowNavigation` = production host only, `allowMixedContent:false`.
- `versionCode 3` / `versionName "3"` (TWA was 2). Brand colours `#123F2E`/`#0B1F17` in `colors.xml`; TWA launcher icons copied (not moved) into `mipmap-*`.
- `signingConfigs.release` reads the 4 env vars; release tasks fail fast with a clear message when unset; debug/sync work without them.
- Manifest: `usesCleartextTraffic="false"`. Permissions so far: `INTERNET` only (template default).
- `assembleDebug`: BUILD SUCCESSFUL → `android/app/build/outputs/apk/debug/app-debug.apk` (gitignored build output, not committed).
- Device check (loads live-site login screen): NOT TESTED — no device attached.

## Phase 3 — web-side native bridge (done, UNIT-TESTED)

- Verified from the installed packages: the shell injects `window.Capacitor`
  (Bridge.java `addDocumentStartJavaScript` + `native-bridge.js` asset), so
  detection needs NO bundled runtime; each plugin's JS wrapper (ESM
  `dist/esm/index.js`) MUST be bundled — hence dynamic `import()` after
  `isNative()`. `@capacitor-community/background-geolocation` ships no JS at
  all: reached via core `registerPlugin("BackgroundGeolocation")` (verified
  in its `definitions.d.ts`: `addWatcher` → `Promise<string>`,
  `removeWatcher({id})`, `openSettings()`).
- `apps/web/src/native/`: `platform.ts` (zero Capacitor imports),
  `push.ts` (channels `job_offers` HIGH/private, `active_delivery` LOW,
  `messages` DEFAULT; token/register/tap), `location.ts` (watcher
  lifecycle, same report semantics as the web hook), `network.ts`,
  `lifecycle.ts` (deep links), `external.ts` (system-browser interceptor,
  D5). Added `@capacitor/*` 8.x + background-geolocation to
  `apps/web/package.json` (workspace-hoisted, no behavior change on web).
- Branched `push-opt-in.tsx` (native+rider → FCM toggle; native+non-rider
  → nothing) and `location-sharing.tsx` (native+rider → watcher UI with an
  honest screen-off disclosure; native+non-rider → nothing). Web paths
  byte-for-byte unchanged. `NativeShell` in `app.tsx` installs the
  external-link interceptor + notification-tap/deep-link routing when native.
- Bundle evidence (non-native entry): main `index-bLX4h9Qt.js` 552.00 kB
  (gzip 141.98) → `index-CyjVAalV.js` 560.13 kB (gzip 144.22): +8 kB raw of
  adapters/components only. Main chunk contains ZERO "capacitor" strings;
  all plugin code (e.g. `index-jyOAJ8Vv.js` PushNotifications wrapper,
  `index-C7nSr84o.js` registerPlugin runtime, `web-*.js` web fallbacks)
  sits in lazy chunks reached only via dynamic `import()`. Precache 23 → 31
  entries (new lazy chunks, not eager).
- Tests: web 9 files 39/39 (20 prior + 19 new: platform detection, push
  adapter incl. channel IDs + token forwarding, location adapter incl.
  permission-denied mapping, component gating native±rider).
- Known gap: FCM token is obtained on-device but NOT yet sent to the API
  (routes land in Phase 4); native location reports to the existing endpoint
  but the full disclosure screen + device test land in Phase 5.

## Phase 4 — native push FCM (done, UNIT-TESTED)

- API (`apps/api`): new `DevicePushToken` model (token unique, user FK,
  platform/appVersion, lastSeenAt; `dev.db` backed up first per R3 as
  `dev.db.bak-android-native`). Routes `POST /api/push/native/register`
  + `/unregister` (requireAuth, zod, 60/min limit; ownership-scoped like
  Web Push; re-register moves the token). `FcmSender`: hand-rolled FCM HTTP
  v1 (RS256 JWT → OAuth token cached to expiry-60 s → one POST per token;
  no firebase-admin dep). Optional `FCM_PROJECT_ID` /
  `FCM_SERVICE_ACCOUNT_PATH` (file path, never in repo) in config +
  `.env.example`; unset → disabled gracefully (log once) and
  `/api/health` reports `nativePush: "disabled"|"enabled"`.
- Fan-out: `sendToUser` tries native tokens first (HIGH priority,
  `channel_id` job_offers for offer/assignment else messages,
  collapse_key/tag = existing tag, data url/tag/kind). Dead tokens dropped
  on 404/NOT_FOUND/INVALID_ARGUMENT. De-dupe: a recent (≤30 d) token that
  was JUST reached suppresses that send's Web Push; FCM failures fall back
  to Web Push; stale tokens never suppress (but refresh/prune on attempt).
  Logout deletes all native tokens server-side (guarantee); client
  unregisters its own token first (best-effort, mirrored).
- Client: channels created before register (job_offers HIGH + bundled loud
  `offer_alert.wav` in `res/raw`, private visibility; active_delivery LOW;
  messages DEFAULT); in-app explanation before the Android 13 prompt;
  token registered after login (+appVersion), unregistered on logout
  (Preferences-stored token), rotation re-fires the same listener.
  Tap → deep link (`data.url`, cold start included) via NativeShell.
  Build succeeds without `google-services.json` (template conditional);
  without Firebase the toggle honestly reports "not available".
- Merged-manifest audit: INTERNET, COARSE/FINE_LOCATION,
  FOREGROUND_SERVICE(+_LOCATION), POST_NOTIFICATIONS, WAKE_LOCK,
  ACCESS_NETWORK_STATE (FCM IID), c2dm RECEIVE. Stripped with
  `tools:node="remove"`: SCHEDULE_EXACT_ALARM + RECEIVE_BOOT_COMPLETED
  (injected by local-notifications for unused scheduling). NO
  ACCESS_BACKGROUND_LOCATION.
- Tests: api 49 files 372/372 (358 prior + 14 new: auth/validation/move,
  ownership, logout sweep, health, dedupe/suppress/fallback/refresh/prune,
  disabled no-op, real-JWT HTTP shape incl. token caching + dead mapping);
  web 41/41 (token register/unregister, toggle→register flow).
- Gates: root typecheck/lint green; `assembleDebug` green; APK contains
  `res/raw/offer_alert.wav`.
- NOT DEVICE-TESTED: needs the human's Firebase project + service account
  (BLOCKERS #1) and a device (BLOCKERS #4). Test plan: enable toggle as a
  rider → server row appears → broadcast offer → FCM wakes phone on
  job_offers channel with loud sound → tap opens the offer.
- Known limitations: no custom small push icon (default app icon is used;
  a white-on-transparent asset can replace it later); server registration
  only takes effect after the human deploys the API.

## Phase 5 — background location (done, UNIT-TESTED)

- Watcher starts ONLY after the prominent disclosure (what/when/why/who/
  how-to-stop, copy in `apps/web/src/native/location-disclosure.ts`) AND
  only while the rider has an active delivery (`hasActiveDelivery` from the
  dashboard's own `activeJobs`; button disabled otherwise). API unchanged.
- Stops (with a `paused` report, same semantics as the web hook) on manual
  stop, delivery end (auto effect on the flag flip: complete/cancel/
  unassign all covered), and logout. Ongoing notification:
  “Sharing location for your active delivery” — no customer details.
- Killed-service honesty: a persisted flag detects “was sharing when the
  app closed” and shows “tap to resume” — never claims continuity, never
  auto-resumes. Permission-denied / GPS-off / start-error states all have
  honest UI; “background” is shown ONLY while the watcher runs.
- Battery: one-time, optional, skippable card linking to the OS app
  settings (`openSettings()`); dismissal persisted. No forced exemption.
- Legal updated for background + FCM: `legal.tsx` Location section and
  push-processor line; `store/LISTING.md` precise-location row.
- `native/DEVICE_TEST.md`: full device script (5-min locked-screen test,
  expected logcat guidance without invented strings, push + offline parts).
- Tests: web 45/45 (disclosure-before-start, no-delivery gate, auto-stop
  on delivery end, killed-service honesty, battery-once); e2e
  rider-dashboard 1/1 serial.
- NOT DEVICE-TESTED (no phone attached — BLOCKERS #4). If the service
  stops reporting with the screen off, the rule is: capture logcat, file
  in BLOCKERS, do NOT silently add ACCESS_BACKGROUND_LOCATION.

## Phase 6 — offline resilience (done, UNIT-TESTED)

- Audit (exact): `idb-keyval` in deps, zero imports (no data cache, no
  queue — only the SW shell precache + realtime ConnectionStatus badge
  existed). `navigator.onLine` only in `realtime.tsx`. No duplication: the
  queue/cache extend those exact seams.
- Network: `RealtimeProvider` subscribes `@capacitor/network` when native
  (forces only the honest "offline" label; "live" stays socket-owned). No
  second badge; riders get one dashboard line “Offline — changes will sync”.
- Cache: last-known rider jobs/offers in IndexedDB (existing dep), shown
  ONLY while offline with an explicit age (“Showing last saved jobs (3m
  ago) — you're offline”).
- Queue: accept-offer / accept-job / transition, each with an idempotency
  key, persisted in IndexedDB, replayed in order on reconnect/online/mount.
  Deliver stays PENDING until the server confirms (UI renders only
  server data; pending items say “Pending sync”, never “Delivered”).
  Rejections (taken/cancelled/wrong PIN) become failed items with the
  server message + Retry/Dismiss — never silent. 401/403 stops without
  marking; transport errors stop and stay pending.
- Server: new `IdempotencyKey` (per-user composite id; successes only —
  rejections are deterministic guarded 409s) on offer-accept, job-accept,
  transition; opportunistic 7-day prune. `dev.db` backed up first (R3).
- Tests: api 50 files 377/377 (+5 idempotency: replay-equality,
  no-key-409, cross-user isolation, transition replay, malformed key);
  web 53/53 (+6 queue: order/keys/stop-on-offline/reject-surface/
  auth-stop/dismiss/selectors; +2 cache roundtrip/age); e2e
  rider-dashboard + offers 3/3 serial.
- Cold start offline: NOT verified on a device (no phone). Expected to
  work after one online visit (SW precache); if the WebView doesn't honor
  it, that's a recorded limitation, not a bundled-assets build (out of
  scope). Device steps are section C of DEVICE_TEST.md.

## Phase 7 — lock-screen action buttons (SKIPPED, design note)

- Phases 4–6 are green, so this was attempted as a design review, not code:
  FCM notification messages can't carry actions; Accept/Decline needs the
  data-message path (a small native `FirebaseMessagingService` building the
  notification + PendingIntents to `/rider?offer=ID&action=accept`, which
  the web app then performs through the normal authenticated API).
- Skipped deliberately: it needs google-services runtime verification, a
  device, and native code that can't be unit-tested here — the three things
  this environment lacks. The loud offer channel + tap-to-open (Phases 3–4)
  already cover the waking requirement. Revisit with a phone + Firebase.

## Machine notes (Phase 0)

- `java -version`: no Java runtime on PATH.
- `adb`: not on PATH.
- No Capacitor packages installed yet; no device/emulator attached.
- JDKs reportedly at `/opt/homebrew/opt/openjdk@{17,21,27}` and SDK at `/opt/homebrew/share/android-commandlinetools` — to verify in Phase 1.

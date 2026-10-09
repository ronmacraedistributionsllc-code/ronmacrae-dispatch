# ANDROID NATIVE FEATURES — AGENT PROMPT
### Ronmacrae Dispatch · the rider ("bearer") app · Google Play package `com.login.dispatched`

You are a senior mobile + full-stack engineer working inside this monorepo. Your job is to add **phone-only native features on top of the existing website** and produce a signed Android build. The website, logins, API and database must keep working exactly as they do today.

**Work in phases. Finish and verify each phase before starting the next. After every phase, update `native/PROGRESS.md` (create it in Phase 0) so you can recover if your context resets. At the start of each new phase, re-read only that phase plus sections 2–4.**

---

## 1. GOAL AND NON-GOALS

**Goal.** Ship an Android app that wraps the live site (https://orders.ronmacraedistributions.com) and adds, for **riders only**, these native capabilities:

| Requested capability (from the Beatz playbook) | What it means for a dispatch app — build THIS |
|---|---|
| Push notifications | Native FCM push so a **new job offer / assignment / message wakes the phone with the app closed**, on a high-priority channel with a loud sound. |
| Lock-screen music controls | Lock-screen presence for an **active delivery**: an ongoing notification (customer-safe text) while a delivery is in progress. Optional stretch: Accept / Decline buttons on the offer notification. |
| Background playback | **Background location sharing during an active delivery** (Android foreground service of type `location`) so dispatch keeps seeing the rider when the screen is off or the app is backgrounded. Plus a loud repeating offer-alert sound on the offer channel. |
| Offline downloads | **Offline resilience**: cached app shell + last-known job list, and an **offline action queue** (accept / collect / deliver) that syncs when the network returns. |

> Music playback itself (media session, track downloads) does **not** apply to a delivery app. Do not add audio-player features. If you think the owner really wants audio features, write that question into `native/BLOCKERS.md` and continue.

**Non-goals (do NOT do these):** redesign the website; change auth or the database model beyond what Phase 4 requires; build iOS (keep the code Capacitor-based so iOS can be added later, but build nothing for iOS now); publish to Google Play; deploy to production; push to GitHub.

---

## 2. VERIFIED FACTS ABOUT THIS REPO AND MACHINE (do not re-guess; re-verify only if a command contradicts them)

**Repo:** `/Users/geniussound/Developer/Genius-AI-Workspace/ronmacrae-dispatch` — npm workspaces: `packages/*` (contracts, geo, money, notifications), `apps/*` (api, web), `e2e`. Read `HANDOFF.md`, `BLOCKERS.md`, `WORK_IN_PROGRESS.md`, and `android/README.md` first.

**Stack.** API = Fastify + Prisma (SQLite dev, Postgres prod) + custom JWT auth + custom WebSocket realtime hub. Web = Vite + React 18 + react-router + TanStack Query + `vite-plugin-pwa` (`injectManifest`, custom `apps/web/src/sw.ts`) + `idb-keyval`. CI (`.github/workflows/ci.yml`, Node 22) runs: `npm install`, `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run build`, then Playwright e2e. **All of those must stay green.**

**Roles.** One shared login routes by role. A "bearer" = a rider (`Rider`). Rider UI is `apps/web/src/pages/rider-dashboard.tsx` (831 lines). Merchants, logistics companies, staff and admins use the same site but must never get native-only behaviour.

**Existing push (Web Push / VAPID).** `apps/api/src/modules/push.ts`: `PushService` with `subscribe / unsubscribe / sendToUser / sendToRider / sendToBusinessStaff`, model `PushSubscription` (prisma `schema.prisma` line ~205, unique `endpoint`, `p256dh`, `auth`), routes `GET /api/push/public-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe` (constants in `packages/contracts/src/routes.ts` ~line 468). Callers: `modules/offers.ts:133`, `modules/delivery-messages.ts:237`, `modules/jobs/assign.ts:136`, `modules/jobs/create.ts:103`. Payload shape: `{ title, body, tag, url }`. Client: `apps/web/src/components/push-opt-in.tsx`, `apps/web/src/lib/push.ts`, `apps/web/src/sw.ts`.
**Android WebView does not support the Web Push API** — so inside the native shell the existing `PushOptIn` UI would report "unsupported". That is why native FCM is required.

**Existing GPS.** `apps/web/src/lib/geolocation.ts` → `useForegroundLocationSharing(riderId)`; rendered by `components/location-sharing.tsx` in the rider dashboard. It reports to `POST /api/rider-locations/:id/report` with body `{ point:{lat,lng}, trackingState:"active"|"paused", clientSeq }` (throttled 8 s). Its docstring is deliberate: **it never claims background tracking it cannot do.** Keep that honesty — the UI may only say "sharing in background" while the native service is genuinely running.

**Existing offline bits (verified).** Workbox precaches the app shell (`src/sw.ts`). `idb-keyval` is listed in `apps/web/package.json` but **is not imported anywhere** — there is **no offline data cache and no offline action queue today**. `lib/realtime.tsx` already tracks a `ConnectionStatus` of `"live" | "reconnecting" | "offline"` with exponential backoff (max 30 s) and an `onReconnect` hook, and `components/layout.tsx` already shows that status as a coloured badge — reuse it instead of inventing a second indicator. `lib/alert-sound.ts` synthesises an in-page beep (works only while the page is open). **Re-grep before building anything** so you don't duplicate what exists.

**Existing Android project = a TWA** (Bubblewrap) in `android/`: `twa-manifest.json` (`packageId: com.login.dispatched`, host `orders.ronmacraedistributions.com`, `appVersionCode: 2`, `minSdkVersion: 21`, signing key alias `ronmacrae-dispatch`), `generate-project.mjs`, `upload-release.mjs`. A TWA **cannot** run a background-location service or native FCM, which is why we are moving to a Capacitor shell. A sideload APK of the TWA is served publicly from `apps/web/public/downloads/ronmacrae-dispatch.apk`, and `apps/web/public/.well-known/assetlinks.json` is live. **Leave all of those untouched.**

**Signing material (SECRET).** `android/android-keystore` and `android/keystore-credentials.txt` exist locally and are gitignored. See Hard Rule R1.

**Machine (macOS, Apple silicon).** Node v26.8.1. JDKs installed via Homebrew but **not on PATH**: `/opt/homebrew/opt/openjdk@17`, `@21`, `@27` (use `JAVA_HOME=/opt/homebrew/opt/openjdk@NN/libexec/openjdk.jdk/Contents/Home`). Android SDK at `/opt/homebrew/share/android-commandlinetools` (platforms `android-34`, `android-36`; build-tools 34/35/36; platform-tools incl. `adb`). **No emulator and no device attached right now.** `sdkmanager` is in that SDK's `cmdline-tools`.

**Capacitor versions on npm today (verified):** `@capacitor/core` & `@capacitor/android` & `@capacitor/cli` 8.5.3 (CLI requires Node ≥ 22), `@capacitor/push-notifications` 8.1.3 (peer `@capacitor/core >=8`), `@capacitor/local-notifications` 8.3.1, `@capacitor/network` 8.0.1, `@capacitor/app` 8.1.2, `@capacitor/preferences` 8.0.1, `@capacitor-community/background-geolocation` 1.2.26 (peer `@capacitor/core >=3`). These postdate most model training data — **read each package's own README/CHANGELOG in `node_modules` rather than relying on memory of older versions.**

---

## 3. DECISIONS ALREADY MADE (do not re-open them)

1. **Capacitor, not TWA, not a rewrite.** New project in **`native/`** at the repo root. It is **not** added to the root `workspaces`, so the website's CI/Docker are unaffected by Capacitor's Node ≥ 22 requirement and Gradle files. Add `native/` generated output (`android/app/build`, `.gradle`, `node_modules`, etc.) to `.gitignore`, and add the generated Android folders to the `ignores` list in `eslint.config.js`.
2. **The native app loads the live site** via Capacitor `server.url = "https://orders.ronmacraedistributions.com"` (the website "stays as is"). Therefore: new website code only takes effect after the **human** deploys it; the native shell must degrade gracefully against the currently deployed site.
3. **`appId` stays `com.login.dispatched`** (same Play listing, same upload key). App name "Ronmacrae Dispatch". `versionCode` must be **> 2**; use 3 unless Phase 8 finds a higher number is needed. The existing TWA in `android/` stays as-is until the human decides to retire it.
4. **Native-only code is gated** by `Capacitor.isNativePlatform()` **and** the signed-in user being a rider. Desktop/mobile web behaviour and non-rider roles must be byte-for-byte unaffected (add tests proving it).
5. **Security lock-down of the bridge.** Because the WebView loads a remote origin that can call native plugins: set `server.allowNavigation` to only `orders.ronmacraedistributions.com`; open every other URL in the system browser (`@capacitor/browser` or an intent); set `server.cleartext = false`; no `webContentsDebuggingEnabled` in release; no extra plugins beyond those named in this prompt.
6. **Minimal permissions.** Declare only what is used: `INTERNET`, `POST_NOTIFICATIONS`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `WAKE_LOCK` (if the plugin needs it). **Do not request `ACCESS_BACKGROUND_LOCATION`** unless Phase 5's device test proves the foreground service stops reporting without it — Google Play requires a special declaration form and demo video for that permission, and a location foreground service started while the app is on screen does not need it. After each build, inspect the **merged** manifest (`app/build/intermediates/merged_manifests/**/AndroidManifest.xml`); if a plugin injects a permission you don't want, remove it with `tools:node="remove"`.
7. **Honest status labels.** Everything you report is labelled `IMPLEMENTED`, `UNIT-TESTED`, `DEVICE-TESTED`, or `NOT TESTED (reason)`. Never say a feature "works on the phone" without a device/emulator run.

---

## 4. HARD RULES

**R1 — Secrets.** NEVER `cat`, `head`, print, copy, move, rename, upload, summarise or paste: `android/android-keystore`, `android/keystore-credentials.txt`, any `*.jks`/`*.keystore`, any `.env*` (including `.env`), any service-account/`google-services.json`/`*-service-account*.json`, or anything under `.opencode/` or `.claude/`. You may *reference their path*. Signing passwords reach Gradle only through **environment variables the human exports in their own shell** (`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`) read by `signingConfigs` in `build.gradle` — never on the command line, never in a committed file. If you need a value you don't have, add it to `native/BLOCKERS.md` and continue with everything else.
**R2 — Git.** Work on a new branch `android-native` created from the current `master`. Commit small and often with clear messages. **Never push, never force anything, never rewrite history, never `git clean`/`reset --hard` without first running `git status` and stashing.** Do not commit generated build output, `node_modules`, keystores, or `google-services.json`.
**R3 — Database safety.** `apps/api/data/dev.db` is development data but treat it carefully: before any Prisma schema change, copy it to `apps/api/data/dev.db.bak-android-native` (this repo's own convention — see `WORK_IN_PROGRESS.md`). Never run `migrate reset`, `db push --force-reset`, or anything that drops data. Read `apps/api/scripts/prepare-db.mjs` and the existing `schema.generated.prisma` flow first, and follow how this repo already evolves its schema.
**R4 — Scope.** Don't touch other portals, the TWA project, `.well-known/assetlinks.json`, `public/downloads/*.apk`, CI workflow, or Docker files, except where a phase says so. Don't reformat unrelated files.
**R5 — Never invent.** If a plugin API, Gradle option or Play policy detail isn't confirmed by the installed package's docs or by a command's real output, say so and verify; do not guess. If something is blocked on a credential or an account, **stop that item, log it in `native/BLOCKERS.md`, and keep going** on everything else.
**R6 — Don't loop.** If the same command fails 3 times with the same error, stop, write what you tried and the exact error into `native/BLOCKERS.md`, and move to the next independent task.
**R7 — Downloads.** `npm install`, `npx cap`, Gradle dependency resolution and `sdkmanager` installs of SDK components are allowed. Before any download > 500 MB (e.g. an emulator system image), print the command and size and prefer a physical device. Never install anything system-wide with `sudo`.

---

## 5. PHASES

### Phase 0 — Safety checkpoint and orientation
1. `git status` must be clean (else stop and report). `git switch -c android-native`. Tag the starting point: `git tag pre-android-native`.
2. Read the docs listed in §2. Read `apps/web/src/pages/rider-dashboard.tsx`, `lib/push.ts`, `components/push-opt-in.tsx`, `lib/geolocation.ts`, `components/location-sharing.tsx`, `lib/realtime.tsx`, `src/sw.ts`, `apps/api/src/modules/push.ts`, `modules/offers.ts`.
3. Run the baseline gates and record results in `native/PROGRESS.md`: `npm run typecheck && npm run lint && npm run test:unit && npm run build`. Do **not** proceed if the baseline is red — report it.
4. Create `native/PROGRESS.md` (phase table: not started / in progress / done + test evidence) and `native/BLOCKERS.md`.
**Gate:** baseline numbers recorded; branch + tag exist.

### Phase 1 — Toolchain check
1. `JAVA_HOME` choice: look at what the installed `@capacitor/android` template requires (after Phase 2 scaffolding: `native/android/build.gradle`, `variables.gradle`, `gradle/wrapper/gradle-wrapper.properties`) and pick the matching installed JDK (17/21/27). Use `export JAVA_HOME=…` inside the commands/scripts you write; don't edit shell profiles.
2. Check which Android platform/build-tools version the template needs (`compileSdk`, `targetSdk`, `buildToolsVersion`); if missing from `/opt/homebrew/share/android-commandlinetools`, install exactly that with `sdkmanager "platforms;android-NN"` / `"build-tools;X.Y.Z"` and note it in PROGRESS.md.
3. `adb devices` — note whether a physical device is attached. If none, record that Phase 8 device tests are pending the human plugging one in (preferred) — or ask via BLOCKERS whether to create an emulator (R7).
**Gate:** `npx cap doctor` (from `native/`) reports no Android problems.

### Phase 2 — Scaffold the Capacitor shell (`native/`)
1. `native/package.json` (private) with `@capacitor/core`, `@capacitor/cli`, `@capacitor/android` at the **same** version, plus the plugins from §2 that you will actually use.
2. `native/capacitor.config.ts`: `appId: "com.login.dispatched"`, `appName: "Ronmacrae Dispatch"`, `webDir` pointing at a tiny placeholder folder (Capacitor requires one), `server: { url, cleartext:false, allowNavigation:[the one host] }`, `android: { allowMixedContent:false }`.
3. `npx cap add android`. Set `versionCode`/`versionName` from `twa-manifest.json` + 1 (see §3.3). Apply the splash/icon/brand colours from `android/twa-manifest.json` (`#123F2E`, `#0B1F17`, `#000000` nav) and reuse the existing icon PNGs from `android/app/src/main/res/mipmap-*` and `android/store_icon.png` (copy, don't move).
4. `signingConfigs.release` in `native/android/app/build.gradle` reading the four env vars from R1; **release builds must fail with a clear message if they're unset**; debug builds need none.
5. Network security: `usesCleartextTraffic=false`.
**Gate:** `cd native/android && JAVA_HOME=… ./gradlew assembleDebug` succeeds; the APK installs and loads the live site login screen (device) — or mark device portion `NOT TESTED` per Phase 1.3. Commit.

### Phase 3 — Web-side native bridge (small, gated, tested)
1. Add `apps/web/src/native/` with: `isNative()` (wraps `Capacitor.isNativePlatform()`), `platform.ts`, and thin typed adapters for push, location service, network status, and app-lifecycle. **Verify in the installed packages whether plugin JS must be bundled into the website when `server.url` is remote; if yes, add only the needed `@capacitor/*` packages to `apps/web/package.json` and load them with dynamic `import()` only when `isNative()` so the normal web bundle size/behaviour is unchanged.**
2. Branch `components/push-opt-in.tsx` and `components/location-sharing.tsx` on `isNative()` and rider role. Web users see **exactly** what they see today.
3. Unit tests (Vitest + jsdom, Capacitor mocked): non-native → old path untouched; native + rider → new path; native + non-rider → neither feature shown.
**Gate:** root `typecheck`, `lint`, `test:unit`, `build` all green; the web bundle for the non-native entry has no new eager imports (check `dist` chunk list before/after and record it).

### Phase 4 — Native push (FCM) end-to-end
**API (apps/api):**
1. New Prisma model `DevicePushToken { id, userId (FK), token @unique, platform ("android"), appVersion?, createdAt, updatedAt, lastSeenAt }` following the repo's schema-evolution flow (R3). Business/role scoping like `PushSubscription` (a token belongs to exactly one user; re-registering moves it).
2. Routes (constants added to `packages/contracts/src/routes.ts`): `POST /api/push/native/register`, `POST /api/push/native/unregister`; both `requireAuth`, zod-validated, rate-limited like neighbours.
3. Extend `PushService` with an FCM HTTP v1 sender. Config via **optional** env vars added to `config.ts` + `.env.example` (names only, no values): `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_PATH` (a **file path**; the file itself is never in the repo). When unset, native push is **disabled gracefully** (log once, no crash) and `/api/health` reports `nativePush: "disabled"`.
4. `sendToUser` sends to native tokens too. Message: notification + data (`url`, `tag`, `kind`), `android.priority: "HIGH"`, `android.notification.channel_id`: `job_offers` (offers/assignments) or `messages`, `collapse_key`/`tag` = the existing tag. Drop tokens on `UNREGISTERED`/`INVALID_ARGUMENT` like the existing 404/410 handling. **De-dupe rule:** if a user has a native token seen in the last 30 days, skip that user's Web Push sends (document the trade-off in the checkpoint file).
5. Vitest tests with the FCM HTTP call mocked: register/unregister auth + ownership; send fan-out; dead-token cleanup; disabled-mode no-op; payload shape.
**Client (native/ + apps/web/src/native):**
6. Create notification channels on first launch **before** requesting a token: `job_offers` (IMPORTANCE_HIGH, custom loud sound in `res/raw`, vibration, visibility PRIVATE with a generic public version e.g. "New delivery offer" — no customer address on the lock screen), `active_delivery` (LOW, ongoing), `messages` (DEFAULT).
7. Request `POST_NOTIFICATIONS` (Android 13+) with a short in-app explanation first; register the FCM token with the API after login; unregister on logout (mirror how `auth.tsx` handles Web Push on logout); refresh on token rotation.
8. Notification tap → deep link to the offer/job (`data.url`), also from a cold start.
9. `google-services.json`: expected at `native/android/app/google-services.json` (gitignored, human-supplied — see §7). Make the Gradle build **succeed without it** (apply the google-services plugin only if the file exists) and have push report "not configured" in that case.
**Gate:** API + web unit tests green; debug build succeeds with and without `google-services.json`; with it present and a device attached, send a test FCM message (the human supplies the service account) — otherwise mark `DEVICE-TESTED: NO (needs Firebase project)`.

### Phase 5 — Background location during an active delivery
1. Use `@capacitor-community/background-geolocation` (foreground service + persistent notification). **Read its installed README first** (API names, Android permission behaviour, notification text options). Start the watcher only when a rider has an **active delivery** and has tapped "Share my location" (the existing explicit opt-in); stop it on delivery completion/cancel/logout/sharing-off.
2. Reuse the existing reporting path — `POST /api/rider-locations/:id/report`, same body, same 8 s throttle, incrementing `clientSeq`. **Do not change the API.** Handle `trackingState: "paused"` on stop exactly as the web hook does.
3. **Prominent disclosure screen** before the OS location prompt, in plain words: what is collected (location), when (only while sharing during a delivery, including when the screen is off), why (dispatch can see where you are), who sees it (dispatch staff of your business), how to stop (button + notification). Needed for Google Play policy; keep the copy in one constants file so the human can edit it.
4. Ongoing notification text: "Sharing location for your active delivery" — no customer details.
5. UI honesty: add states `native-sharing` / `native-stopped` / `permission-denied`; the label "background" only while the native watcher reports it's running. Handle permission denied, GPS off, and the service being killed (restart cleanly when the app next opens; do not fake continuity).
6. Merged-manifest check per §3.6; **if** the service stops reporting without background permission in the device test, stop and record it in BLOCKERS with logs rather than silently adding `ACCESS_BACKGROUND_LOCATION`.
7. Battery: provide a one-time, optional, skippable screen linking to the OS "unrestricted battery" setting for this app (Doze/OEM killers are the #1 real-world failure) — plain-language only, no forced exemption request.
**Gate:** unit tests for the state machine with the plugin mocked; debug build installs; **device test script** in `native/DEVICE_TEST.md` (steps + expected logcat lines) that the human or you run: start sharing → lock screen for 5 min → confirm reports keep arriving at the API → stop → confirm `paused` reported.

### Phase 6 — Offline resilience
1. **Audit first** (`grep -rn "idb-keyval\|navigator.onLine\|offline" apps/web/src`): per §2 there is no data cache and no action queue yet, only the shell precache and the realtime `ConnectionStatus` badge. Write down exactly what exists, then build only the gaps.
2. Network status: extend the existing `ConnectionStatus` in `lib/realtime.tsx` with `@capacitor/network` on native (the plugin reports real connectivity changes more reliably than `navigator.onLine` in a WebView). Show a small non-blocking line "Offline — changes will sync" to riders only; do not add a second, competing badge.
3. Cache the rider's **last-known job list / active job** in IndexedDB (via the existing `idb-keyval`) and show it, clearly labelled with its age, when offline.
4. **Offline action queue** for rider actions (accept offer, mark collected, deliver). Each queued item has an idempotency key; replay in order on reconnect; show "pending sync" per item. **Critical correctness rules:** the delivery PIN is validated by the server, so an offline "deliver" must stay **pending** (never display "Delivered ✓" until the server accepts it); handle server rejection (offer already taken, job cancelled, wrong PIN) by surfacing a clear message and removing/reverting the item — never silently dropping it. If the API lacks idempotency for any of these endpoints, add an optional `Idempotency-Key` header handling server-side with tests, or document and restrict the queue to safe actions.
5. Cold start offline: confirm the service-worker shell loads inside the WebView after one online visit; if it doesn't, record it as a known limitation in the checkpoint file rather than building a bundled-assets mode (out of scope).
**Gate:** Vitest tests for queue ordering, replay, idempotency, rejection handling, and "never shows delivered while pending"; Playwright e2e only if you can add one without flakiness — otherwise unit-level is acceptable and noted.

### Phase 7 — Lock-screen polish (optional stretch; skip cleanly if Phases 4–6 aren't fully green)
Accept / Decline action buttons on the offer notification. FCM notification messages can't carry actions; this needs a data-message path through a small native `FirebaseMessagingService` that builds the notification and routes actions via `PendingIntent` to deep links (`/rider?offer=ID&action=accept`) which the web app then performs through the normal authenticated API. Only attempt this if you can keep it under ~150 lines of native code with tests; otherwise write a design note in the checkpoint file and stop.

### Phase 8 — Build, sign, document
1. Release build: `./gradlew bundleRelease` (AAB) and `assembleRelease` (APK) with signing env vars **supplied by the human** (R1). If the vars are absent, build unsigned/debug and say so — do not look for the passwords.
2. Verify the AAB: version code, package id, permissions in the merged manifest (list them in the checkpoint file), min/target SDK, `allowNavigation` host in `capacitor.config`, no `google-services.json`/keystore in the repo (`git status`, `git ls-files | grep -i -E "keystore|google-services|credentials|\.env"` must be empty).
3. Write `native/README.md` (how to build, how to run on a device, env vars, how to bump `versionCode`) and `ANDROID_NATIVE_CHECKPOINT.md` at the repo root in the same style as `PHASE3_COURIER_BRANDING_CHECKPOINT.md`: what was built, exact test commands + results, what is `DEVICE-TESTED` vs not, known limitations, the Play Console to-do list (§7), and rollback (`git switch master`; tag `pre-android-native`).
4. Final gates: root `typecheck`, `lint`, `test:unit`, `build`; and `npm run e2e` if the environment supports it (else say why not).
**Gate:** a final report in the format below.

---

## 6. FINAL REPORT FORMAT (print this when done or blocked)
```
ANDROID NATIVE — STATUS
Branch/commits: <branch>, <n> commits, last <hash>
Gates: typecheck PASS/FAIL · lint · test:unit (<n> passed) · build · e2e (run/not run)
Per feature: Push | Background location | Offline queue | Lock-screen presence | Action buttons
   → IMPLEMENTED / UNIT-TESTED / DEVICE-TESTED / NOT TESTED (reason)
Artifacts: <paths to .aab/.apk>, versionCode, signed? (yes/no)
Merged permissions: <list>
Blockers (need the human): <from native/BLOCKERS.md>
Known limitations: <list>
```

---

## 7. THINGS ONLY THE HUMAN CAN DO (log these in `native/BLOCKERS.md`; do not try to work around them)
1. **Firebase:** create/choose a Firebase project → add an Android app with package `com.login.dispatched` → download `google-services.json` into `native/android/app/` (gitignored) → create a service account with FCM send rights → set `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_PATH` on the production API host.
2. **Signing:** export `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`ronmacrae-dispatch`), `ANDROID_KEY_PASSWORD` in their own shell before a release build. Keep `keystore-credentials.txt` backed up in a password manager.
3. **Deploy:** the website/API changes (new routes, Prisma migration, web code) must be deployed to production before the native features work against the live site. Run the schema change through the repo's normal production process.
4. **Google Play Console:** upload the new AAB (existing `android/upload-release.mjs` can do it with their service-account JSON); update the **Data safety** form (location, device identifiers/push token), the **foreground-service / location permission declaration** if prompted, the **privacy policy** (mention location sharing during deliveries and push tokens), and add the new `app signing` SHA-256 where needed. Test on the Internal track first.
5. **A physical Android phone** with USB debugging for the Phase 5/6 device tests (or approval to create an emulator).
6. Decide whether to **retire the TWA** (`android/`, the public APK in `public/downloads`) once the Capacitor build is live.

---

## Addendum (2026-10-09) — state of the repo when you start

- The store-readiness work is **already merged to `master`**: account deletion (all four login types), `/privacy` `/terms` `/support` `/delete-account`, reviewer-accounts script, security fixes, and the `store/` kit. Read `store/BLOCKERS.md`, `store/AAB_VERIFICATION.md` and `store/SECURITY_RULES.md` first. Do not undo any of it.
- **The existing `.aab` in `android/app/build/outputs/bundle/release/` is unsigned and this machine has no JDK.** Install a JDK (Android Studio's bundled one is fine) before Phase 8, add a `signingConfig` that reads the keystore path and passwords from environment variables (never from committed files), and bump `versionCode` (currently 2) in both `twa-manifest.json` and `app/build.gradle`.
- Privacy policy (`apps/web/src/pages/legal.tsx`) and the Data Safety draft (`store/LISTING.md`) currently say location is shared only while the app is open. If you add background location or FCM, **update both** before release.
- `/api/users` and proof routes are now business-scoped; any new endpoint you add must follow the same rule (derive `businessId` from the token, never from the request) and ship with a cross-business test like `apps/api/test/security-rules.test.ts`.

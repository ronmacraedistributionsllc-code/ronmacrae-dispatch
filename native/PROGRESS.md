# Android Native — Progress

Branch: `android-native` · tag: `pre-android-native` (from `master` 7283daf).
Goal: Capacitor shell (`native/`) wrapping https://orders.ronmacraedistributions.com + rider-only native push, background location, offline resilience. No Play submission in this pass.

## Phase table

| Phase | Status | Evidence |
|---|---|---|
| 0 Safety checkpoint + orientation | done | Branch `android-native`, tag `pre-android-native`; baseline below |
| 1 Toolchain check | done | `npx cap doctor`: "Android looking great" (see below) |
| 2 Capacitor shell scaffold | done | `assembleDebug` BUILD SUCCESSFUL; APK installs/loads live site: NOT TESTED (no device) |
| 3 Web-side native bridge | not started | — |
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

## Machine notes (Phase 0)

- `java -version`: no Java runtime on PATH.
- `adb`: not on PATH.
- No Capacitor packages installed yet; no device/emulator attached.
- JDKs reportedly at `/opt/homebrew/opt/openjdk@{17,21,27}` and SDK at `/opt/homebrew/share/android-commandlinetools` — to verify in Phase 1.

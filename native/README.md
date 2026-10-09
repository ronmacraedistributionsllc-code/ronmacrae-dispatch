# Ronmacrae Dispatch — Android native shell (Capacitor)

Rider ("bearer") app for Google Play package `com.login.dispatched`. This
is a thin Capacitor shell around the live site
(https://orders.ronmacraedistributions.com) plus rider-only native
features: FCM push, background location during active deliveries, and an
offline action queue. The website, logins, API, and database work exactly
as before — desktop/mobile web and non-rider roles never load native code.

`native/` is deliberately NOT in the root npm workspaces, so the
website's CI/Docker never see Capacitor or Gradle.

## Prerequisites

- Node ≥ 22, JDK **21** (`@capacitor/local-notifications` demands a Java
  21 toolchain; JDK 17 fails the build):
  `export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`
- Android SDK (platform `android-36`, build-tools 36.x):
  `export ANDROID_HOME=$HOME/Library/Android/sdk`
  `export ANDROID_SDK_ROOT=$HOME/Library/Android/sdk`
- A physical Android phone with USB debugging for device tests
  (preferred), or an approved emulator.

## Everyday commands (from `native/`)

```bash
npm install            # install shell deps (standalone package)
npx cap sync android   # regenerate android project files from config+plugins
npx cap doctor         # must report "Android looking great"
```

Build from `native/android` (with `JAVA_HOME`/`ANDROID_HOME` exported):

```bash
./gradlew assembleDebug   # debug APK, no signing needed
./gradlew bundleDebug     # unsigned debug AAB (for inspection only)
```

## Release build (human only)

Export in YOUR OWN shell (never in a file, never on a shared command
line — the keystore in `android/` is gitignored and was never opened by
automation):

```bash
export ANDROID_KEYSTORE_PATH=/path/to/upload-keystore
export ANDROID_KEYSTORE_PASSWORD=...
export ANDROID_KEY_ALIAS=ronmacrae-dispatch
export ANDROID_KEY_PASSWORD=...
cd native/android && ./gradlew bundleRelease assembleRelease
```

Without those four vars, release tasks fail fast with a clear message;
debug builds never need them.

## Firebase (human only)

Push needs a Firebase project with an Android app `com.login.dispatched`:

1. Download `google-services.json` into `native/android/app/`
   (gitignored — the build succeeds without it; push then reports
   "not configured").
2. Create a service account with FCM send rights; set `FCM_PROJECT_ID`
   and `FCM_SERVICE_ACCOUNT_PATH` (a file path, never the JSON itself)
   on the production API host.
3. Deploy the API + web changes first — the shell loads the LIVE site,
   so native features only work after deploy.

## Bumping `versionCode`

Play requires a strictly increasing version code. Edit
`native/android/app/build.gradle` (`versionCode`/`versionName`) — current
release line is 3 (the old TWA was 2). Then rebuild + re-verify with
`aapt dump badging` (see `ANDROID_NATIVE_CHECKPOINT.md`).

## Device test

Follow `native/DEVICE_TEST.md` (location 5-minute locked-screen test,
push wake test, offline queue test).

## What lives where

- `capacitor.config.ts` — appId, live-site URL, navigation lock-down
  (production host only; everything else opens in the system browser).
- `android/app/src/main/` — manifest (minimal permissions, cleartext off),
  brand colours/icons (copied from the TWA, not moved), `res/raw/
  offer_alert.wav` (loud offer channel sound).
- `../apps/web/src/native/` — the web-side bridge (platform detection,
  push/location/network/lifecycle/external adapters). Plugin JS is loaded
  ONLY via dynamic `import()` behind `isNative() && role === "rider"`.
- `PROGRESS.md` / `BLOCKERS.md` / `DEVICE_TEST.md` — status, human-only
  items, test script.

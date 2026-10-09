# Android bundle verification

Checked on 2026-10-09 from this machine. **No JDK is installed here** (`keytool`/`jarsigner`/Gradle can't run), so nothing could be rebuilt or re-signed — only inspected.

| Check | Result |
|-------|--------|
| Package name | `com.login.dispatched` (AAB manifest, `twa-manifest.json`, `assetlinks.json` all agree) ✅ |
| versionCode | `2` in `twa-manifest.json` and `app/build.gradle` ✅ (must be higher than anything already uploaded to Play — it has to be bumped for every new upload) |
| Hosted APK (`/downloads/ronmacrae-dispatch.apk`) signing cert | SHA-256 `16:71:00:A7:…:2F:BF:D5` — **matches** the single fingerprint in `/.well-known/assetlinks.json` ✅ |
| AAB `android/app/build/outputs/bundle/release/app-release.aab` (built 14 Sep, 1.1 MB) | ❌ **Contains no signature** (only `BundleConfig.pb` at its top level; no `META-INF/*.RSA`), and `app/build.gradle` has no `signingConfig`. Google Play rejects an unsigned bundle. The README's claim that this file is signed is wrong. |

## What to do (human or a machine with a JDK)

1. Install a JDK (Android Studio bundles one), then sign the bundle with the **upload key** (the keystore in `android/`, which this pass deliberately never opened):
   `jarsigner -keystore android/android-keystore -sigalg SHA256withRSA -digestalg SHA-256 app-release.aab <key alias>` — or add a `signingConfig` to `app/build.gradle` reading the keystore path/passwords from environment variables, and rebuild with `./gradlew bundleRelease`.
2. No new bundle is needed for web-only changes: the Android app is a Trusted Web Activity and loads the live site, so every fix in this branch reaches Android users the moment the web app deploys.
3. Bump `versionCode` (currently 2) in both `twa-manifest.json` and `app/build.gradle` for each upload.
4. **Play App Signing:** once the app is in Play Console, Google re-signs with its own key. Copy the **App signing key certificate SHA-256** from *Play Console → Setup → App signing* and add it as a second entry in `apps/web/public/.well-known/assetlinks.json` (keep the upload-key one for sideloaded builds). Without it, installs from the Play Store open with a browser address bar instead of full-screen.

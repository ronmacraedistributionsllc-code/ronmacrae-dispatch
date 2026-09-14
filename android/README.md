# Ronmacrae Dispatch — Android (Google Play) wrapper

This is a **Trusted Web Activity (TWA)** — a thin native Android shell
around the real app, which is (and stays) the PWA at
https://orders.ronmacraedistributions.com. There is no separate Android
UI to maintain: every screen, fix, and feature ships the normal way
(deploy the web app) and the Android app picks it up automatically the
next time it's opened. This is the standard, Google-endorsed way to put
a PWA on the Play Store — not a workaround.

## What's here vs. what isn't

Committed (real project source, safe to share): `app/`, `build.gradle`,
`settings.gradle`, `gradle/`, `gradlew`, `twa-manifest.json`,
`generate-project.mjs` (the script that generated all of the above).

**Never committed** (see `.gitignore`): `android-keystore` and
`keystore-credentials.txt` — the app's real signing secret — plus
`node_modules/`, `local.properties`, and Gradle's own `build/`/`.gradle/`
output. The keystore and its password file already exist on this
machine from the build that's been done; **back up
`keystore-credentials.txt` somewhere safe (a password manager) before
this machine's copy is the only one that exists.** Losing it means you
can't sign an update to this exact app listing without Google's Play App
Signing key-recovery process.

## Current status

- A signed release bundle has been built:
  `app/build/outputs/bundle/release/app-release.aab` — this is the file
  you upload to Play Console.
- A debug APK also exists at
  `app/build/outputs/apk/debug/app-debug.apk`, for sideloading onto a
  real device or emulator to look at before you submit anything.
- `apps/web/public/.well-known/assetlinks.json` is deployed live —
  this is what lets the Android OS treat the app as genuinely trusted
  (opens full-screen, no browser address bar) instead of falling back to
  an ordinary Custom Tab. It currently lists the **upload key's**
  fingerprint (see the Play App Signing note below).
- Package name: `com.ronmacraedistributions.dispatch`. App name:
  "Ronmacrae Dispatch". This is easy to change — nothing has been
  submitted to Play Console yet — but once you do submit, the package
  name is permanent for that listing.

## Before you submit — the one thing that needs your Play Console access

Google's **Play App Signing** (the default, and the only flow worth
using) works like this: you upload the app signed with your own
*upload key* (already done — that's `app-release.aab`), and Google
**re-signs it with a separate key it generates and holds for you**
before actually distributing it to users. That means the certificate
fingerprint real user devices check against is **Google's**, not the
upload key's — `assetlinks.json` needs Google's fingerprint too, or the
app installs but never opens full-screen (it'll show a browser bar,
which also fails Play Store review under some policies).

After your first upload to Play Console:
1. Play Console → your app → Setup → App integrity → App signing.
2. Copy the **SHA-256 certificate fingerprint** shown there (labeled
   "App signing key certificate", not "Upload key certificate").
3. Give it to me (or add it yourself) as a second entry in
   `sha256_cert_fingerprints` in
   `apps/web/public/.well-known/assetlinks.json`, then deploy.

## What you still need to do in Play Console (I have no access to do this for you)

- Create the app listing (Play Console → Create app).
- Store listing: short/full description, screenshots (phone + tablet —
  take these from the running app), a feature graphic (1024×500), and
  the app icon (`store_icon.png` in this directory is the 512×512 PNG
  Play Console asks for separately from the in-app manifest icon).
- Content rating questionnaire, target audience, data-safety form
  (what data the app collects — accurate answers based on what this app
  actually does: accounts, location for couriers, order details).
- A privacy policy URL (required by Play Console before publishing).
- Upload `app-release.aab` under Production (or Internal/Closed testing
  first, which is the sensible way to try it before a public release).
- After the first upload, come back and finish the assetlinks.json step
  above.

## Rebuilding after a web app change

The Android wrapper has no code of its own that goes stale — but if you
change the manifest (name, colors, icons) or want to bump the version
for a Play Console re-upload:

```bash
# from the android/ directory
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
node generate-project.mjs   # re-fetches the live manifest, regenerates the project; keystore is untouched
# bump appVersionCode/appVersionName in twa-manifest.json first if this is a Play Console update
./gradlew bundleRelease \
  -Pandroid.injected.signing.store.file="$(pwd)/android-keystore" \
  -Pandroid.injected.signing.store.password="<see keystore-credentials.txt>" \
  -Pandroid.injected.signing.key.alias=ronmacrae-dispatch \
  -Pandroid.injected.signing.key.password="<see keystore-credentials.txt>"
```

Play Console requires `appVersionCode` to strictly increase on every
upload — bump it in `twa-manifest.json` before rebuilding for a real
update (`generate-project.mjs` doesn't do this automatically, since it
re-fetches from the live manifest each time and shouldn't silently reset
your version history).

## Trying it on a device/emulator right now

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$ANDROID_HOME/platform-tools:$PATH"
adb install app/build/outputs/apk/debug/app-debug.apk
```

Needs a connected device (USB debugging on) or a running emulator
(`avdmanager`/`emulator`, not installed by this setup — Android Studio's
own device manager is the easiest way to create one if you want to test
in an emulator instead of a real phone).

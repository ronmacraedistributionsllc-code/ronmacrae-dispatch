# Android native — device test script

Needs: a physical Android phone with USB debugging (preferred) or an
approved emulator, plus the debug APK from `native/android/app/build/
outputs/apk/debug/app-debug.apk`. No signing material, no Firebase, and
no production deploy are needed for the location/offline parts; the push
part additionally needs BLOCKERS #1 (Firebase project + service account).

Build + install:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
cd native/android && ./gradlew assembleDebug
$ANDROID_HOME/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## A. Background location (no Firebase needed)

Setup: two sessions — the phone logged in as a rider, and a desktop
browser logged in as a dispatcher at the same business.

1. On the dispatcher: broadcast a job offer to the rider (or assign
   directly). On the phone: accept it, so the rider has an ACTIVE delivery.
2. On the phone, rider dashboard: the location section shows
   “Share my location” (enabled — NOT the “available while you have an
   active delivery” note).
3. Tap it → the prominent disclosure appears (what/when/why/who/how-to-
   stop). Tap “Not now” → nothing starts, no OS prompt. Tap
   “Share my location” again → “I understand — start sharing”.
4. The OS location prompt appears. Allow → a persistent notification
   “Sharing location for your active delivery” appears; the dashboard
   shows “Sharing in background · last sent …”.
   - Deny instead → the UI says permission was denied and explains how to
     allow it in settings. (No background permission request must ever
     appear — if one does, STOP and record it in BLOCKERS.)
5. Lock the screen for 5 minutes. Then, on the dispatcher map (or
   `GET /api/rider-locations` with a staff token), confirm fresh points
   kept arriving roughly every ~8 s while the screen was off.
   - Watch live with: `adb logcat | grep -i -E "capacitor|backgroundgeo|location"`
     and look for watcher/foreground-service lines (exact tags vary by
     OS version — record what you actually see, don't expect fixed strings).
6. On the phone: complete the delivery (Confirm delivery + PIN) → the
   watcher stops by itself and a `paused` report is recorded. The
   dashboard no longer says “background”.
7. Kill the app from recents mid-sharing, reopen it → it must say sharing
   stopped while the app was closed and ask for a fresh tap (never claim
   it kept sharing).
8. Battery hint: first visit shows “Keep location sharing alive” once;
   “Don't show again” hides it permanently; “Open app settings” opens
   the OS app settings.

PASS bar: reports keep arriving with the screen off (step 5), stop on
delivery end (step 6), no `ACCESS_BACKGROUND_LOCATION` prompt (step 4).
If reports STOP with the screen off, capture the logcat window and file
it in BLOCKERS — do not silently add the background permission.

## B. Native push (needs Firebase — BLOCKERS #1)

1. `native/android/app/google-services.json` in place (human-supplied,
   gitignored); rebuild + reinstall.
2. As a rider: “Enable push notifications” → OS prompt → allow. Confirm a
   `DevicePushToken` row exists for that user (API database).
3. From the dispatcher: broadcast an offer. With the app CLOSED, the phone
   must wake with a loud alert on the “Delivery offers” channel.
4. Tap the notification → the app opens on the offer/job (deep link).
5. Sign out → the token row is gone (server) and no more pushes arrive.

## C. Offline queue (Phase 6 — no Firebase needed)

1. As a rider with an active job: turn on airplane mode → the connection
   badge shows offline and queued actions show “pending sync”.
2. Accept / collect / deliver while offline → deliver stays PENDING
   (never “Delivered ✓”) until the server accepts it.
3. Airplane mode off → the queue replays in order; rejections (offer
   taken, wrong PIN) surface as messages, never silent drops.

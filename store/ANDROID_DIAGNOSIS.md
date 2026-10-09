# "It isn't working on the Android" — diagnosis checklist

No Android device is attached to this machine and the owner has not yet said what fails, so no defect was found or fixed on Android. The web app itself was exercised in Chromium and on the iPhone simulator. Work down this list and stop at the first "no":

1. **Which Android app?** The Play/TWA build, the sideloaded APK (`/downloads/ronmacrae-dispatch.apk`), or the site in Chrome? Behaviour differs.
2. **Does the site work in Chrome on that phone?** Open `https://orders.ronmacraedistributions.com`. If it fails there, it's a web problem, not the wrapper.
3. **Is there a browser address bar at the top of the app?** If yes, Digital Asset Links failed and Android treats the app as a plain browser tab. Causes, most likely first:
   - Installed from Play but `assetlinks.json` has only the **upload** key. Add Google's **App signing key** SHA-256 (see `AAB_VERIFICATION.md` step 4).
   - Installed APK was signed with a different key than the one in `assetlinks.json`. The hosted APK matches (verified 2026-10-09).
   - Check live: `https://orders.ronmacraedistributions.com/.well-known/assetlinks.json` must return 200 JSON with `package_name` `com.login.dispatched`.
4. **Blank/white screen or old version?** Chrome → Settings → Apps → Ronmacrae Dispatch → Clear storage (clears the service worker), then reopen.
5. **Sign-in fails?** Phone numbers must be valid Jamaican/international numbers (`+1876…`); the sign-in page normalises them. Try the email form to separate "bad number" from "bad password".
6. **Push notifications missing?** Settings → Notifications must be on for the app; sign in once with the app open so it can register. Note that SMS/WhatsApp are **not** sent in production until Twilio is configured (`notifications: "memory"` in `/api/health`).
7. **Location not updating?** Android → App permissions → Location → "Allow only while using the app", with the app in the foreground. Background location is not supported by the web wrapper (that's what the native plan adds).

Send the owner's answer to #1–#3 plus a screenshot and this can be narrowed in one more step. If a USB device is available: `adb logcat | grep -i -E "chromium|TWA|dispatch"` (adb is at `/opt/homebrew/share/android-commandlinetools/platform-tools/adb`).

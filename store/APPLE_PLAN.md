# Apple App Store plan

**Status: not started by design.** There is no iOS project, no Apple Developer account in this repo, and creating either needs the owner's Apple ID. Nothing here was signed or submitted.

## The real risk: Guideline 4.2 (minimum functionality)
Apple rejects apps that are "just a website in a wrapper". The Android build is a Trusted Web Activity, which Apple has no equivalent of; an iOS submission needs a native shell, and that shell must offer something a bookmark can't. Be prepared for a rejection on first submission. What helps, in order of value:

1. **Native push notifications** (APNs) for new jobs and offers — the web app already has Web Push; a Capacitor shell would swap in APNs.
2. **Background-capable courier location** while a delivery is active (needs the "Always/When In Use" strings and a clear purpose).
3. **Offline tolerance** for couriers (queue status changes, retry on reconnect).
These are exactly what `ANDROID_NATIVE_PROMPT.md` plans for Android with Capacitor; the same project can add iOS.

## Apple requirements this build already meets (verify in App Store Connect)
- In-app account deletion (My account → Delete my account) — Guideline 5.1.1(v).
- Public privacy policy URL and a support URL — `/privacy`, `/support`.
- Review access: `store/REVIEWER_GUIDE.md`.
- No sign-in with a third-party identity provider, so "Sign in with Apple" is not required.

## Human to-do list
1. Enroll in the Apple Developer Program (US$99/year, owner's Apple ID, D-U-N-S not needed for an individual).
2. Decide the native shell (Capacitor recommended) and have the coder add the iOS target; Xcode is installed here, but signing needs the owner's team.
3. Create the App Store Connect record: bundle id (suggest `com.login.dispatched`), privacy answers from `LISTING.md`, age rating, screenshots at 6.9" (1320×2868) and 6.5".
4. TestFlight first; submit only after a real iPhone passes the courier and dispatcher flows.

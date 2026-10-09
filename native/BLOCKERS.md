# Android Native — Blockers (need the human)

Logged per R5/R6: stop the blocked item, keep going on everything else.

1. **Firebase project** — needs: Firebase project + Android app `com.login.dispatched` + `google-services.json` placed at `native/android/app/google-services.json` (gitignored) + service account with FCM send rights + `FCM_PROJECT_ID` / `FCM_SERVICE_ACCOUNT_PATH` on the production API host. Blocks Phase 4 device test only.
2. **Signing env vars** — `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` exported in the human's own shell before any release build. Blocks Phase 8 signed artifacts only; debug/unsigned builds proceed without them.
3. **Production deploy of web/API changes** — new routes, Prisma change, and web bridge code only take effect in the native app after the human deploys the site/API. Blocks live behavior, not local builds/tests.
4. **Physical Android device** (USB debugging) — preferred for Phase 5/8 device tests; emulator creation needs explicit approval (R7, >500 MB download). Currently no device attached.
5. **Play Console work** (NOT done in this pass): upload AAB, Data safety form, foreground-service/location declaration, privacy policy update, app-signing SHA-256 → `assetlinks.json`, internal-track testing, TWA retirement decision.

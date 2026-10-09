# Blockers — things this pass could not do, and why

| # | Blocker | Who | Severity |
|---|---------|-----|----------|
| 1 | **Play Console / App Store Connect submission.** Needs the owner's Google/Apple logins and payment of the one-time fees. Nothing was uploaded or submitted. | Owner | Required |
| 2 | **Signed Android bundle.** The AAB on disk is unsigned (no `META-INF` signature, no `signingConfig`) and this machine has no JDK, so it can't be built or signed here. Needs a JDK + the upload keystore (never opened by this pass). See `AAB_VERIFICATION.md`. | Owner / coder with a JDK | Required for Play |
| 3 | **Legal review.** Privacy policy and Terms are drafts written from the code's actual behaviour. They carry a visible DRAFT banner; a person must review them (and remove the banner) before the store listing goes live. | Owner (+ lawyer) | Required |
| 4 | **Support inbox.** `ops@ronmacraedistributions.com` is a placeholder in the pages and listing. Confirm the mailbox exists and is monitored, or change `SUPPORT_EMAIL` in `apps/web/src/pages/legal.tsx`. | Owner | Required |
| 5 | **SMS/WhatsApp are no-ops in production.** `/api/health` reports `notifications: "memory"`. Customers/couriers get no texts until Twilio credentials are configured on Render. (Email is live: `email: "resend"`.) | Owner | High, not a store blocker |
| 6 | **Reviewer accounts on production.** `npm run reviewer-accounts` must be run by the owner against the production database; the passwords go straight into the store consoles. | Owner | Required |
| 7 | **Play App Signing fingerprint** must be added to `assetlinks.json` after the first upload, or the Play install shows a browser bar. | Owner | Required |
| 8 | **Apple.** No Developer account, no iOS project; Guideline 4.2 rejection risk for a thin web wrapper. See `APPLE_PLAN.md`. | Owner + coder | Required for iOS |
| 9 | **Android "isn't working".** Not reproducible without the owner's description or a device. See `ANDROID_DIAGNOSIS.md`. | Owner | Unknown |
| 10 | **Native features** (FCM push, background location, offline) — `ANDROID_NATIVE_PROMPT.md`, to be run after this branch is merged. Needs Firebase project + signing env vars from the owner. | Coder | Optional for v1 |
| 11 | **Known low-severity:** a deleted/disabled account's current 15-minute access token keeps working until expiry. | Coder | Low |
| 12 | **Mobile UX:** the Jobs table is wide on a phone (status/rider columns scroll off to the right). Fine for a first review, worth a card layout later. | Coder | Low |

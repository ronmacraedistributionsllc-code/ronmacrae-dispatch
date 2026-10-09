# Submission checklist

`[DONE]` = finished and verified in this repo. `[HUMAN]` = only the owner can do it. Anything in `[HUMAN]` without a strike-through is still open.

## Product requirements
- [DONE] In-app account deletion, all four login types, with tests (`account-deletion.test.ts`, `store-compliance.spec.ts`)
- [DONE] Web page explaining how to delete (`/delete-account`)
- [DONE] Public privacy policy, terms, support pages, linked from the sign-in page (DRAFT banner)
- [DONE] Reviewer demo accounts script + guide (`REVIEWER_GUIDE.md`)
- [DONE] 15/15 security rules proven by tests; three real holes fixed (`SECURITY_RULES.md`)
- [DONE] Startup warnings for no-op email/SMS
- [DONE] Courier search
- [DONE] Typecheck, lint, build, API tests (358) and e2e (50, twice in a row) green

## Store assets (`store/`)
- [DONE] Listing text, short/full description, keywords (`LISTING.md`)
- [DONE] Data Safety + App Privacy draft answers (`LISTING.md`) — [HUMAN] verify each against the live form
- [DONE] 6 phone screenshots 1080×1920 + 1024×500 feature graphic (`store/screenshots/`, regenerate with `node store/capture-screenshots.mjs`)
- [HUMAN] App icon 512×512 (use `android/store_icon.png`) and tablet screenshots if you want tablet listing
- [HUMAN] Apple screenshots (6.9", 6.5") from a real iOS build

## Before you submit — Google Play
1. [HUMAN] Review and approve the Privacy Policy and Terms; remove the DRAFT banner (`apps/web/src/pages/legal.tsx`, `DraftBanner`)
2. [HUMAN] Confirm the support email, or change `SUPPORT_EMAIL`
3. [HUMAN] Run `npm run reviewer-accounts` against production; paste credentials into **App access**
4. [HUMAN] Install a JDK, sign a release bundle with the upload key, bump `versionCode` (`AAB_VERIFICATION.md`)
5. [HUMAN] Create the app in Play Console (package `com.login.dispatched`), upload the signed `.aab` to Internal testing first
6. [HUMAN] Fill Data safety, content rating, target audience (not for children), ads declaration (none) — answers in `LISTING.md`
7. [HUMAN] Copy the Play **App signing key** SHA-256 into `apps/web/public/.well-known/assetlinks.json`, deploy, and re-test that the installed app has no browser bar
8. [HUMAN] Personal Play accounts created after Nov 2023 must run a **closed test with 12+ testers for 14 days** before production — **VERIFY** current rule in the console
9. [HUMAN] Promote to Production

## Apple
See `APPLE_PLAN.md`. [HUMAN] everything: Developer Program enrollment, native shell, App Store Connect record, TestFlight, review.

## Operations
- [HUMAN] Configure Twilio on Render if customers/couriers should get SMS/WhatsApp (`notifications` is `memory` in production today)
- [HUMAN] Back up `android/keystore-credentials.txt` and the keystore somewhere safe — losing them means Play key-recovery

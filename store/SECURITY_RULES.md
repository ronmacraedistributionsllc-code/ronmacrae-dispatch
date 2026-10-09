# Security rules → code → proof

The platform's 15 stated security rules, each mapped to where it is enforced and the test that proves it.
All tests run in `npm run test:unit` (API suite: `apps/api/test`). "NEW" = written during store-readiness.

| # | Rule | Enforced in | Proof | Result |
|---|------|-------------|-------|--------|
| 1 | Private notifications stop after explicit logout | `auth.ts` `/api/auth/logout` (deletes sessions **and** push subscriptions — NEW); web `logout()` also unsubscribes the device first | `security-rules.test.ts` › rule 1 (NEW) | ✅ |
| 2 | Backend authorization enforces store/company access | `requireStaff`, `requireMerchantAuth`, `requireLogisticsAuth`, per-route `businessId` filters | `multi-tenancy.test.ts`, `merchant-portal.test.ts`, `logistics.test.ts` | ✅ |
| 3 | Admin impersonation never exposes passwords | `platform-admin.ts` impersonation; `impersonatedBy` claim blocks self-deletion | `admin-delete-impersonation.test.ts` › "never exposes or changes their password"; `account-deletion.test.ts` › impersonation refused | ✅ |
| 4 | Account deletion preserves order/audit integrity | soft delete (`deletedAt`) in `account-deletion.ts` and platform delete | `account-deletion.test.ts` (job history intact, audit row written); `admin-delete-impersonation.test.ts` › "historical records survive" | ✅ |
| 5 | Sensitive account changes require verification | self-delete needs current password; platform delete/impersonate owner-only; customer claim needs emailed code; **cross-business credential edits now blocked (NEW)** | `account-deletion.test.ts` (wrong password → 403), `customer-account.test.ts`, `security-rules.test.ts` › rules 10 & 15 | ✅ |
| 6 | Signup itself does not require email verification | `/api/auth/login` no longer gates on `emailVerifiedAt` | `rider-signup.test.ts` › "can sign in right away… nothing about pending membership or unverified email" | ✅ |
| 7 | Pending accounts are not reported as "invalid credentials" | login only returns 401 for a wrong identifier/password; pending/disabled/deleted get specific messages | `rider-signup.test.ts` (login 200 while membership pending), `admin-delete-impersonation.test.ts` (`not.toBe(401)`, "Account deleted" vs "disabled") | ✅ |
| 8 | No plaintext passwords | `lib/password.ts` hashing; DTOs never include hashes | `password.test.ts`; `security-rules.test.ts` › rule 8 (NEW: DB, API bodies, audit log) | ✅ |
| 9 | No client-controlled roles | zod schemas strip unknown keys; role changes are admin-only | `security-rules.test.ts` › rule 9 (NEW: signup smuggling role/platformRole/status; dispatcher can't create/promote) | ✅ |
| 10 | No cross-company/store data leakage | business-scoped queries everywhere. **Fixed (NEW):** `GET /api/users` listed every user globally; proof photos upload/download checked only "is staff" | `multi-tenancy.test.ts`; `security-rules.test.ts` › rules 10 & 15 and "delivery proof photos" (both fail on the old code) | ✅ |
| 11 | No unauthorized precise courier location exposure | `/api/rider-locations` limited to active-membership riders; customers see location only via the job's tracking token | `multi-tenancy.test.ts` › GPS; `tracking.test.ts` | ✅ |
| 12 | No duplicate rating per courier/order/rater | a second rating is rejected | `ratings.test.ts` › "cannot rate it twice", "cannot double-rate either" | ✅ |
| 13 | Only one courier can atomically claim an open delivery | offer accept uses a guarded `updateMany`; COD/settlement claims likewise | `offers.test.ts` (two concurrent accepts → one wins; accept vs assign race), `cod.test.ts` concurrent cases | ✅ |
| 14 | Master-admin global delete is audited | `platform.user.delete` audit action | `admin-delete-impersonation.test.ts` › "master admin global delete" (audit asserted) | ✅ |
| 15 | Org managers can remove memberships but can't globally delete unrelated users | `PATCH /api/users/:id` now limited to the caller's own business and refuses people who also work elsewhere (NEW); global delete is owner-only | `security-rules.test.ts` › rules 10 & 15; `admin-delete-impersonation.test.ts` › "a non-owner is refused entirely" | ✅ |

**15/15 proven by a test.** Three of the proofs (rules 1, 10, 15) were written because the rule did **not** hold:

## Findings fixed in this pass (all tested; tests fail on the pre-fix code)

1. **HIGH — cross-company account takeover.** `PATCH /api/users/:id` was reachable by *any* business's admin and edited *any* user by id: set a new password, change the email, disable, or promote. That included another company's admin and the platform owner. `GET /api/users` likewise listed every account on the platform. Now both only see people with a membership in the caller's business; the owner and other companies' people return 404; and a person who also works with another business (or has a merchant/fleet login) can only be renamed, not re-credentialed, by one business.
2. **MEDIUM — delivery proof photos.** Any staff account (including read-only `viewer`) of *any* business could attach a file to any job and download proof photos for any job whose key it knew. Now limited to the job's own business, the job's own courier, and the platform owner.
3. **LOW — logout left push subscriptions behind** if the device couldn't unsubscribe itself (offline/closed tab). Logout now removes them server-side.

## Known, not fixed (documented, low)

- Access tokens are stateless with a 15-minute life, so a deleted or disabled account's *current* access token keeps working until it expires (refresh is revoked immediately). Closing this means a per-request user lookup; not done here.
- `GET /api/riders?includeInactive=false` parses with `z.coerce.boolean()`, so the string `"false"` counts as true. Pre-existing, harmless to security.
- The role dropdown on the Team page edits the user's legacy `role` and (new) their membership role in the current business; there is still no UI for removing a membership without deactivating the person.

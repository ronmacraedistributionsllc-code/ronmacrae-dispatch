# Reviewer access (paste into Play "App access" / App Store "Sign-in required")

Reviewers sign in to a **separate demo business** that contains no real customers, phone numbers or addresses.

## Create the logins (owner, once)
Run against production with the production `DATABASE_URL` set in your shell (never committed):

```bash
npm run reviewer-accounts --workspace @ronmacrae/api -- --i-understand-this-writes-data
```

It prints the target database host first, creates three accounts plus two demo orders, and prints each password **once**. Re-running changes nothing unless you add `--reset-passwords`. Copy the passwords straight into the store console; they are not stored anywhere readable.

| Role | Sign-in | What they can do |
|------|---------|------------------|
| Dispatcher | `reviewer.dispatcher@app-review.example` | Jobs, map, team, cash, reports for the demo business only |
| Merchant | `reviewer.merchant@app-review.example` | Merchant portal for "Demo Store" |
| Courier | `reviewer.courier@app-review.example` | Courier dashboard with one assigned demo delivery |

All three use the normal sign-in page; the app routes each to the right workspace. The `.example` domain can never receive email, so nothing real is ever sent.

## Notes for the reviewer (paste)
- Open the app → sign in with the email and password above.
- Account deletion: **My account → Delete my account** (type DELETE and re-enter the password). Please don't delete the demo accounts during review; if you need to test deletion, ask and we'll provide a disposable one.
- Location: only the courier role uses precise location, and only while the app is open on a delivery.
- Privacy policy: `/privacy` · Support: `/support`.

## Owner housekeeping
Rotate the passwords with `--reset-passwords` after each review round, and confirm nothing in the demo business is real data.

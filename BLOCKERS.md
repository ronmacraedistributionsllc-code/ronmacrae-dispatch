# Blockers — Stage 30 (multi-merchant public ordering)

Everything that did **not** require a credential, external account, or
production DNS/hosting access was implemented and tested (see
`WORK_IN_PROGRESS.md` / `PHASE1_JOBS_CHECKPOINT.md` for the full write-up).
This file lists only the items that are genuinely blocked on something only
the account owner can provide, plus one informational correction.

## 1. Stack correction (informational, not a blocker)

The build spec was written against a Supabase/RLS/Edge-Functions mental
model. This application does **not** use Supabase — it's Fastify + Prisma
(SQLite for dev, Postgres for production) + a custom JWT auth layer + a
custom WebSocket realtime hub. All "RLS-equivalent" work in this stage was
done as server-side `businessId`/`merchantId` scoping in the Prisma query
layer (e.g. `jobListWhere()`, every new route's `requireStaff` guard), which
is the enforcement mechanism this codebase already uses everywhere else.
No action needed from you — noted so nothing here is mistaken for a gap.

## 2. Real email delivery — needs a Resend API key

**What's built:** `packages/notifications/src/email.ts` has a real
`ResendEmailProvider` (HTTP call to `https://api.resend.com/emails`, HTML +
text body, `to`/`from` support). `apps/api/src/modules/merchant-notify.ts`
sends a full HTML+text order-notification email to the merchant's
`notificationEmails` immediately on order creation, with an idempotency
guard (`merchantNotifiedAt`) and a `force` resend option. It currently runs
with `EMAIL_PROVIDER=memory`, which logs the exact outbound email (subject,
full body, recipient) to the server log instead of sending it — verified
working end-to-end in this stage's live test (see the `[email]` line in
`/tmp/ronmacrae-tunnel.log` for order RM-000071).

**What's needed from you:** a [Resend](https://resend.com) account (or tell
me to wire a different provider — Postmark/SendGrid would be a similar-sized
change) and:
```
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxxxxxx
EMAIL_FROM=orders@ronmacraedistributions.com   # must be a domain verified in Resend
```
Until you provide this, merchant emails are logged, not delivered — the code
path is otherwise complete and needs no further changes once the key exists.

## 3. Production-grade geocoding — needs a maps API key (optional)

The public order form and admin address entry already work today via the
existing keyless OpenStreetMap/Nominatim fallback (this is what geocoded
"3 Constant Spring Road, Kingston" correctly in this stage's live test).
`GOOGLE_MAPS_API_KEY` and `JAMNAV_API_KEY` are optional upgrades for
higher-accuracy/higher-volume geocoding in Jamaica — not required for the
system to function, so this is not blocking, just worth knowing about if
address-matching quality becomes an issue at real order volume.

## 4. Production domain, DNS, and hosting

`ronmacraedistributions.com` is referenced throughout the spec as the public
order URL (`https://ronmacraedistributions.com/order`,
`.../order/vbr-basics`), and already appears in this repo's own
`.env.example` (`WOO_API_URL`, `VAPID_SUBJECT`) as the real production
domain for the existing WooCommerce integration. I have no access to:
- DNS for that domain (to point it at wherever this app is hosted)
- A production hosting account (droplet/server, or whatever replaces the
  current LAN + Cloudflare-tunnel demo setup)
- The production Postgres database (`DATABASE_URL`) and `SESSION_SECRET`
- TLS/SSL certificate provisioning for the real domain

**What's needed from you:** tell me where this should be deployed (a
DigitalOcean droplet, since `.env.example` already assumes "DigitalOcean
managed Postgres" — or somewhere else), and I can write the exact deployment
steps/scripts for that target. Once you have a server reachable at that
domain, deployment is: `npm run build` at the repo root, `DEV_DB` unset,
`DATABASE_URL` pointed at the real Postgres instance, `node scripts/prepare-db.mjs`
(runs `prisma db push` — safe, additive, no destructive flag against
Postgres), then run `apps/api/dist/main.js` behind your reverse proxy/TLS
terminator with `WEB_DIST=$(pwd)/apps/web/dist`.

## 5. Cosmetic: `APP_ORIGIN` is set to localhost in the current demo `.env`

Not a code bug — `Merchant.orderUrl`, tracking links, and the "View this
order" link inside the merchant notification email all correctly *use*
`APP_ORIGIN`, but the demo environment's `.env` still has
`APP_ORIGIN=http://localhost:5173` (a pre-existing gap from before this
stage — tracking links had the same issue already). Once a real production
domain exists (see #4), set:
```
APP_ORIGIN=https://ronmacraedistributions.com
```
and every generated link (merchant order URLs, tracking links, email
"view order" links) will automatically point at the right place — no code
change required.

## Not blocked — explicitly out of scope for this stage, not forgotten

These spec sections have no credential/access blocker; they just weren't
part of the vertical slice built in this stage and are listed here so
they're tracked rather than silently dropped:
- Polygon-drawn delivery zones (today: center + radius, in `zone-manager.tsx`)
- Merchant-staff portal (separate login/role scoped to one merchant)
- Route optimization UI surfacing (the `optimizeStops` function already
  exists in `packages/geo` and is unused by any screen)
- CAPTCHA/Turnstile on the public order form (abuse protection today is
  rate-limiting + server-side re-pricing only)
- Full multi-item order entry on the staff-facing `new-job.tsx` (this stage
  added a merchant selector there; the form itself is still single-item —
  multi-item entry only exists on the new public `/order` form)

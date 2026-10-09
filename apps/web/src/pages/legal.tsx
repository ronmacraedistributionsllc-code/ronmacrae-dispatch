import React from "react";
import { Link } from "react-router-dom";

/**
 * Public privacy / terms / support / data-deletion pages — required by both
 * app stores, reachable without signing in.
 *
 * EVERY statement below was derived from what the code actually does
 * (verified by reading it: session/token lifetimes in lib/jwt.ts, the
 * order-trash purge in jobs/trash.ts, tracking-link TTL in config.ts, the
 * geocoder in packages/geo, messaging in packages/notifications, location
 * visibility in modules/tracking.ts, deletion in modules/account-deletion.ts).
 * If any of that behaviour changes, change these pages in the same commit.
 *
 * DRAFT: written by the engineering side, not reviewed by a lawyer. The
 * owner must review them (and confirm the support address is monitored)
 * and then remove DRAFT_BANNER below. Nothing here claims compliance with
 * any specific law.
 */
const SUPPORT_EMAIL = "ops@ronmacraedistributions.com"; // TODO(owner): confirm this inbox is monitored
const UPDATED = "9 October 2026";

function DraftBanner(): React.JSX.Element {
  return (
    <div role="note" className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200" data-testid="draft-banner">
      <strong>DRAFT — owner/legal review required.</strong> This page describes what the app actually does today but
      hasn't been reviewed by a lawyer yet.
    </div>
  );
}

function LegalPage({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-dvh bg-zinc-950">
      <div className="mx-auto max-w-2xl space-y-5 p-4 pb-16">
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-xs text-zinc-500">
          <Link to="/login" className="font-bold text-brand-accent">Ronmacrae Dispatch</Link>
          <Link to="/privacy" className="underline">Privacy</Link>
          <Link to="/terms" className="underline">Terms</Link>
          <Link to="/support" className="underline">Support</Link>
          <Link to="/delete-account" className="underline">Delete account</Link>
        </nav>
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-xs text-zinc-500">Last updated {UPDATED}</p>
        </header>
        <DraftBanner />
        <div className="space-y-4 text-sm leading-relaxed text-zinc-300 [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_a]:text-brand-accent [&_a]:underline">
          {children}
        </div>
      </div>
    </div>
  );
}

export function Privacy(): React.JSX.Element {
  return (
    <LegalPage title="Privacy policy">
      <p>
        Ronmacrae Dispatch is a delivery-dispatch service for Jamaica. It connects customers who order, the stores
        (“merchants”) who sell, the couriers who deliver, the logistics companies that supply couriers, and the dispatch
        staff who coordinate them. This page explains what we collect, why, who sees it, and how to remove it.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Customers (placing an order):</strong> name, phone number, optional email, delivery address (as you typed it and the map position it matched), landmark/unit, what you ordered and its price, payment method, delivery instructions, and messages you send about a delivery.</li>
        <li><strong>Customers (optional account):</strong> an email address and a password (stored only as a one-way hash). Your phone is verified with a one-time code sent by SMS/WhatsApp.</li>
        <li><strong>Couriers:</strong> name, phone, email, vehicle type, optional licence plate, the deliveries you handle and their cash-on-delivery records, ratings you receive, and — only while you have location sharing switched on — your device's precise location.</li>
        <li><strong>Merchants and logistics companies:</strong> business name and contact details, pickup address, product catalogue, staff logins, and (for logistics companies) which couriers are attached to them.</li>
        <li><strong>Staff:</strong> name, email or phone, role, optional two-factor secret, and a log of the actions you take (who did what, when).</li>
        <li><strong>Devices:</strong> if you turn on notifications, a push-notification address for your browser/device. We use a sign-in cookie and local storage to keep you signed in and remember your theme.</li>
      </ul>
      <p>We do not use advertising or analytics trackers, and we do not sell personal information.</p>

      <h2>Why we use it</h2>
      <ul>
        <li>To take, assign, track, and deliver orders, and to reconcile cash collected on delivery.</li>
        <li>To tell you what's happening — order updates, offers and assignments for couriers, new-order alerts for dispatch.</li>
        <li>To keep accounts secure and to investigate disputes (the action log).</li>
      </ul>

      <h2>Location</h2>
      <p>
        A courier's location is collected only when they switch location sharing on, and only while they have an
        active delivery. In a web browser this works while the app is open on screen. In the Android app, sharing
        continues while the delivery is active even if the screen is off or the app is in the background — the app
        shows a permanent notification while this is happening, and sharing stops by itself when the delivery ends
        (or whenever the courier taps “Stop sharing location”). Dispatch staff of the business
        a courier works for can see that location. A customer can see their courier's position only while their own
        delivery is out with the courier — not before it's assigned and not after it's finished.
      </p>

      <h2>Who else handles data for us</h2>
      <ul>
        <li><strong>Maps and routing:</strong> delivery addresses and pickup/drop-off coordinates are sent to OpenStreetMap services (Nominatim for address search, OSRM for routing) to find the place and estimate the route. If the business has configured them, Google Maps or JamNav may be used instead.</li>
        <li><strong>Messaging:</strong> Twilio delivers SMS/WhatsApp messages (your phone number and the message text).</li>
        <li><strong>Email:</strong> verification codes and some order emails are sent through Resend when email is enabled.</li>
        <li><strong>Push notifications:</strong> delivered through the push service of your browser or phone maker (for example Google, Apple, or Mozilla). The Android app uses Google's Firebase Cloud Messaging, which handles a device push token for each phone with notifications switched on. Content is kept minimal — a courier's job alert shows the pickup and the general delivery area; no alert includes a customer's name, phone number, or delivery PIN.</li>
        <li><strong>Hosting:</strong> the service runs on Render, behind Cloudflare.</li>
      </ul>

      <h2>Who sees what</h2>
      <p>
        Each business only sees its own orders, customers, and couriers. A logistics company sees the deliveries its
        own couriers carry, but not the customer's name, phone, or address. Couriers see the details of jobs assigned to
        them. Platform administrators can view and support any account and their actions are logged; they can sign in as
        a user to help, and that is recorded and shown on screen.
      </p>

      <h2>How long we keep things</h2>
      <ul>
        <li>Sign-in sessions last up to 30 days; a customer's order-lookup session lasts 24 hours.</li>
        <li>Order tracking links expire after 72 hours by default. Verification codes expire after 10 minutes.</li>
        <li>An order that dispatch deletes goes to a trash and is permanently removed after 30 days.</li>
        <li>We have not set an automatic expiry for completed-order records, ratings, cash-reconciliation entries, or the action log — they are kept so businesses' books, disputes, and audits keep adding up.</li>
      </ul>

      <h2>Deleting your account</h2>
      <p>
        You can delete your account yourself, inside the app (<Link to="/delete-account">how</Link>). This closes the
        login, signs you out everywhere, and stops notifications. It does <strong>not</strong> erase past orders,
        deliveries, ratings, or payment records: those belong to the businesses involved and are kept so their records
        stay accurate. Deleted accounts can't sign in again. If you can't sign in, <Link to="/support">contact support</Link>.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Turn notifications on or off any time from the app's side menu or your device settings.</li>
        <li>Couriers can stop location sharing at any time.</li>
        <li>Ask us what we hold about you, or to correct it, via <Link to="/support">support</Link>.</li>
      </ul>

      <h2>Children</h2>
      <p>This service is for businesses and the adults who use them; it isn't directed at children.</p>

      <h2>Changes and contact</h2>
      <p>If we change what we collect we'll update this page. Questions: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
    </LegalPage>
  );
}

export function Terms(): React.JSX.Element {
  return (
    <LegalPage title="Terms of use">
      <p>By using Ronmacrae Dispatch you agree to these terms. If you don't agree, please don't use the service.</p>

      <h2>The service</h2>
      <p>
        Ronmacrae Dispatch lets customers place delivery orders, merchants receive them, and couriers and dispatch staff
        carry them out. Delivery fees, product prices, and cash-on-delivery amounts are set by the businesses involved;
        the app calculates and records them but isn't a party to the sale.
      </p>

      <h2>Accounts</h2>
      <ul>
        <li>Give accurate details and keep your password private. You're responsible for what happens under your login.</li>
        <li>Merchant, courier, and logistics-company accounts are approved by the platform before they can work. We may decline, suspend, or close an account that breaks these terms or puts others at risk.</li>
        <li>You can delete your account at any time (see the privacy page).</li>
      </ul>

      <h2>Couriers</h2>
      <ul>
        <li>Couriers are responsible for cash they collect on delivery and must hand it in and have it reconciled.</li>
        <li>Share your location only through the app's sharing control; don't tamper with or fake it.</li>
        <li>Follow the law while making deliveries, including traffic and safety rules.</li>
      </ul>

      <h2>Customers</h2>
      <ul>
        <li>Be reachable at the phone number you give and provide a usable delivery address.</li>
        <li>Keep your delivery PIN private until the courier is with you.</li>
      </ul>

      <h2>Acceptable use</h2>
      <p>Don't misuse the service: no fraud, harassment, scraping, attempts to access other people's data, or interference with the system.</p>

      <h2>Availability and liability</h2>
      <p>
        We work to keep the service running but can't promise it will always be available or error-free. To the extent
        the law allows, we aren't liable for indirect losses, or for the conduct of the businesses, couriers, and
        customers who use the service. Nothing here limits rights you have under the law that can't be limited.
      </p>

      <h2>Changes and contact</h2>
      <p>We may update these terms; continued use means you accept the update. Contact: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
    </LegalPage>
  );
}

export function Support(): React.JSX.Element {
  return (
    <LegalPage title="Support">
      <p>Need help with an order, an account, or your data? Email us and include the order number (it looks like RM-000123) or the phone number on the order.</p>
      <p><a href={`mailto:${SUPPORT_EMAIL}`} className="text-base">{SUPPORT_EMAIL}</a></p>
      <h2>Common questions</h2>
      <ul>
        <li><strong>Where's my order?</strong> Open the tracking link we sent you, or use “My packages” on the sign-in page with your phone number.</li>
        <li><strong>I'm a courier and my application is pending.</strong> A platform administrator approves new couriers; you'll be able to sign in with the same details once approved.</li>
        <li><strong>I want to delete my account or data.</strong> See <Link to="/delete-account">how to delete your account</Link>.</li>
        <li><strong>Privacy questions.</strong> Read the <Link to="/privacy">privacy policy</Link>, or write to us.</li>
      </ul>
    </LegalPage>
  );
}

export function DeleteAccountInfo(): React.JSX.Element {
  return (
    <LegalPage title="Delete your account">
      <p>You can delete your account yourself from inside the app. It takes under a minute.</p>
      <h2>Staff and couriers</h2>
      <ul>
        <li>Sign in, open <strong>My account</strong> from the menu (under <strong>More</strong> on a phone), and choose <strong>Delete my account…</strong>.</li>
        <li>Type DELETE and enter your password to confirm.</li>
      </ul>
      <h2>Merchants and logistics companies</h2>
      <ul>
        <li>Sign in, and use <strong>Delete account</strong> at the bottom of your portal page.</li>
      </ul>
      <h2>Customers</h2>
      <ul>
        <li>Open <strong>My packages</strong> from the sign-in page, sign in, and use <strong>Delete account</strong> in the account section.</li>
      </ul>
      <h2>What happens</h2>
      <ul>
        <li>Your login is closed, you're signed out everywhere, and notifications stop. You can't sign in again.</li>
        <li>Orders, deliveries, ratings, and payment records stay with the businesses they belong to so their records remain accurate. See the <Link to="/privacy">privacy policy</Link>.</li>
      </ul>
      <h2>When we can't delete yet</h2>
      <ul>
        <li>The only admin of a business must make someone else an admin first.</li>
        <li>A courier with a delivery in progress, or cash not yet reconciled, must finish that first.</li>
        <li>Platform owners are handed over by support.</li>
      </ul>
      <h2>Can't sign in?</h2>
      <p>
        For your security we don't delete accounts from a web form without signing in. Email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from the address or phone on the account and we'll verify
        it's you and handle it.
      </p>
    </LegalPage>
  );
}

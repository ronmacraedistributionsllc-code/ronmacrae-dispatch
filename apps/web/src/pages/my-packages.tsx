import React, { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  API,
  CUSTOMER_JOB_STATUS_LABELS,
  TRACKING_STATE_LABELS,
  type CustomerAccountStatusDto,
  type CustomerJobStatus,
  type CustomerPackageDto,
  type CustomerPackagesDto,
} from "@ronmacrae/contracts";
import { formatMoney } from "../lib/api.js";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const STORAGE_KEY = "customerDashboardToken";

class DashboardError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A deliberately separate, minimal fetch helper — not the shared apiFetch()
 * from lib/api.ts. That helper's 401 handling tries to refresh the *staff*
 * session and can fire the app-wide "session expired" callback, which has
 * nothing to do with (and must never affect) a customer's phone-verified
 * dashboard session. See customer-dashboard.ts's own doc comment for the
 * matching reasoning on the API side.
 */
async function dashboardFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  // API contract paths are absolute ("/api/..."); API_BASE already supplies
  // that prefix (and may differ from it, e.g. VITE_API_BASE) — same
  // stripping apiFetch() does, to avoid ending up with "/api/api/...".
  const apiPath = path.startsWith("/api/") ? path.slice(4) : path;
  const res = await fetch(`${API_BASE}${apiPath}`, {
    ...init,
    headers: {
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new DashboardError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

type Step = "phone" | "code" | "emailLogin" | "emailReset" | "dashboard";

/**
 * Public cross-business "my packages" dashboard (spec 4) — phone-verified,
 * no account or password. Reachable from the per-job tracking page's header
 * link, or directly at /my-packages.
 */
export function MyPackages(): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
  const [step, setStep] = useState<Step>(token ? "dashboard" : "phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetRequested, setResetRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);

  function signOut() {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setStep("phone");
    setPhone("");
    setCode("");
  }

  async function emailLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = await dashboardFetch<{ token: string }>(API.customerAccount.login, { method: "POST", body: JSON.stringify({ email, password }) });
      sessionStorage.setItem(STORAGE_KEY, body.token);
      setToken(body.token);
      setStep("dashboard");
    } catch (err) {
      setError(err instanceof DashboardError ? err.message : "Couldn't sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordReset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await dashboardFetch(API.customerAccount.requestPasswordReset, { method: "POST", body: JSON.stringify({ email }) });
      setResetRequested(true);
    } catch (err) {
      setError(err instanceof DashboardError ? err.message : "Couldn't send a reset code.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await dashboardFetch(API.customerAccount.resetPassword, { method: "POST", body: JSON.stringify({ email, code: resetCode, newPassword }) });
      setPassword(newPassword);
      setResetCode("");
      setNewPassword("");
      setResetRequested(false);
      setStep("emailLogin");
    } catch (err) {
      setError(err instanceof DashboardError ? err.message : "Couldn't reset your password.");
    } finally {
      setBusy(false);
    }
  }

  async function requestCode(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await dashboardFetch(API.customerDashboard.requestCode, { method: "POST", body: JSON.stringify({ phone }) });
      setStep("code");
      setCooldownUntil(Date.now() + 30_000);
    } catch (err) {
      setError(err instanceof DashboardError ? err.message : "Couldn't send a code. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = await dashboardFetch<{ token: string }>(API.customerDashboard.verify, {
        method: "POST",
        body: JSON.stringify({ phone, code }),
      });
      sessionStorage.setItem(STORAGE_KEY, body.token);
      setToken(body.token);
      setStep("dashboard");
    } catch (err) {
      setError(err instanceof DashboardError ? err.message : "Couldn't verify that code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-base font-bold text-brand-accent">My packages</div>
          <div className="text-xs uppercase tracking-widest text-zinc-400">Across every store you've ordered from</div>
        </div>
        {step === "dashboard" ? (
          <button className="text-xs text-zinc-500 underline hover:text-zinc-300" onClick={signOut}>
            Not you? Switch number
          </button>
        ) : (
          <a href="/book" className="text-xs text-zinc-500 underline hover:text-zinc-300">
            Book a delivery
          </a>
        )}
      </header>

      {step === "phone" ? (
        <form onSubmit={(e) => void requestCode(e)} className="card space-y-4">
          <div>
            <label className="label" htmlFor="phone">
              Your phone number
            </label>
            <input
              id="phone"
              className="input"
              placeholder="876 555 1234"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoFocus
              required
            />
            <p className="mt-1 text-xs text-zinc-500">We'll text a 6-digit code to confirm it's you — no account or password needed.</p>
          </div>
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button className="btn-accent w-full" disabled={busy}>
            {busy ? "Sending…" : "Send code"}
          </button>
          <button
            type="button"
            className="w-full text-center text-xs text-zinc-500 underline hover:text-zinc-300"
            onClick={() => {
              setError(null);
              setStep("emailLogin");
            }}
          >
            Have an account? Sign in with email
          </button>
        </form>
      ) : step === "code" ? (
        <form onSubmit={(e) => void verifyCode(e)} className="card space-y-4">
          <div>
            <label className="label" htmlFor="code">
              6-digit code
            </label>
            <input
              id="code"
              className="input"
              inputMode="numeric"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              required
            />
            <p className="mt-1 text-xs text-zinc-500">Sent to {phone}. Expires in 10 minutes.</p>
          </div>
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button className="btn-accent w-full" disabled={busy}>
            {busy ? "Checking…" : "View my packages"}
          </button>
          <button
            type="button"
            className="w-full text-center text-xs text-zinc-500 underline hover:text-zinc-300 disabled:opacity-40"
            disabled={busy || (cooldownUntil !== null && Date.now() < cooldownUntil)}
            onClick={() => void requestCode()}
          >
            Resend code
          </button>
          <button type="button" className="w-full text-center text-xs text-zinc-500 underline hover:text-zinc-300" onClick={() => setStep("phone")}>
            Wrong number?
          </button>
        </form>
      ) : step === "emailLogin" ? (
        <form onSubmit={(e) => void emailLogin(e)} className="card space-y-4">
          <div>
            <label className="label" htmlFor="account-email">
              Email
            </label>
            <input id="account-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          </div>
          <div>
            <label className="label" htmlFor="account-password">
              Password
            </label>
            <input id="account-password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button className="btn-accent w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              className="text-zinc-500 underline hover:text-zinc-300"
              onClick={() => {
                setError(null);
                setResetRequested(false);
                setStep("emailReset");
              }}
            >
              Forgot password?
            </button>
            <button
              type="button"
              className="text-zinc-500 underline hover:text-zinc-300"
              onClick={() => {
                setError(null);
                setStep("phone");
              }}
            >
              Use my phone number instead
            </button>
          </div>
        </form>
      ) : step === "emailReset" ? (
        <form onSubmit={(e) => void (resetRequested ? resetPassword(e) : requestPasswordReset(e))} className="card space-y-4">
          <div>
            <label className="label" htmlFor="reset-email">
              Email
            </label>
            <input id="reset-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} disabled={resetRequested} autoFocus required />
          </div>
          {resetRequested ? (
            <>
              <div>
                <label className="label" htmlFor="reset-code">
                  6-digit code
                </label>
                <input id="reset-code" className="input" inputMode="numeric" placeholder="123456" value={resetCode} onChange={(e) => setResetCode(e.target.value)} autoFocus required />
                <p className="mt-1 text-xs text-zinc-500">If that email has an account, a code was sent to it. Expires in 10 minutes.</p>
              </div>
              <div>
                <label className="label" htmlFor="new-password">
                  New password
                </label>
                <input id="new-password" type="password" className="input" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required />
              </div>
            </>
          ) : (
            <p className="text-xs text-zinc-500">We'll email a reset code if that address has an account.</p>
          )}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button className="btn-accent w-full" disabled={busy}>
            {busy ? "Working…" : resetRequested ? "Reset password" : "Send reset code"}
          </button>
          <button
            type="button"
            className="w-full text-center text-xs text-zinc-500 underline hover:text-zinc-300"
            onClick={() => {
              setError(null);
              setResetRequested(false);
              setStep("emailLogin");
            }}
          >
            Back to sign in
          </button>
        </form>
      ) : token ? (
        <Dashboard token={token} onExpired={signOut} />
      ) : null}
    </div>
  );
}

function Dashboard({ token, onExpired }: { token: string; onExpired: () => void }): React.JSX.Element {
  const [data, setData] = useState<CustomerPackagesDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await dashboardFetch<CustomerPackagesDto>(API.customerDashboard.get, {
        headers: { authorization: `Bearer ${token}` },
      });
      setData(body);
      setError(null);
    } catch (err) {
      if (err instanceof DashboardError && err.status === 401) {
        onExpired();
        return;
      }
      setError(err instanceof DashboardError ? err.message : "Couldn't load your packages.");
    }
  }, [token, onExpired]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) {
    return (
      <div className="card">
        <p className="text-sm text-red-300">{error}</p>
        <button className="btn mt-3" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card">
        <p className="text-sm text-zinc-400">Loading your packages…</p>
      </div>
    );
  }
  if (data.active.length === 0 && data.history.length === 0) {
    return (
      <div className="space-y-4">
        <div className="card">
          <p className="text-sm text-zinc-400">No packages found for this number yet.</p>
        </div>
        <AccountPanel token={token} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data.active.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">On the way</h2>
          <div className="space-y-3">
            {data.active.map((pkg) => (
              <PackageCard key={pkg.jobId} pkg={pkg} />
            ))}
          </div>
        </section>
      ) : null}
      {data.history.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">History</h2>
          <div className="space-y-3">
            {data.history.map((pkg) => (
              <PackageCard key={pkg.jobId} pkg={pkg} />
            ))}
          </div>
        </section>
      ) : null}
      <AccountPanel token={token} />
    </div>
  );
}

/**
 * Optional email+password account (spec 7) — additive on top of the
 * phone-OTP session above, never a replacement for it. Collapsed by
 * default so it doesn't compete for attention with the actual packages.
 */
function AccountPanel({ token }: { token: string }): React.JSX.Element | null {
  const [status, setStatus] = useState<CustomerAccountStatusDto | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await dashboardFetch<CustomerAccountStatusDto>(API.customerAccount.status, { headers: { authorization: `Bearer ${token}` } }));
    } catch {
      // Non-critical — the packages list above is the important part; a
      // failed account-status fetch just means this panel stays hidden.
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function claim(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await dashboardFetch(API.customerAccount.claim, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ email, password }) });
      setClaimed(true);
    } catch (err) {
      setError(err instanceof DashboardError ? err.message : "Couldn't create an account.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyEmail(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await dashboardFetch(API.customerAccount.verifyEmail, { method: "POST", body: JSON.stringify({ email, code: verifyCode }) });
      setNotice("Email verified.");
      setClaimed(false);
      await load();
    } catch (err) {
      setError(err instanceof DashboardError ? err.message : "Couldn't verify that code.");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    setBusy(true);
    try {
      await dashboardFetch(API.customerAccount.resendVerification, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      setNotice("Code sent.");
    } catch (err) {
      setError(err instanceof DashboardError ? err.message : "Couldn't resend a code.");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  if (!open && !status.hasAccount) {
    return (
      <button type="button" className="text-xs text-zinc-500 underline hover:text-zinc-300" onClick={() => setOpen(true)}>
        Create an account so you don't need a text code next time
      </button>
    );
  }

  if (status.hasAccount) {
    return (
      <div className="card">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-400">Account</h2>
        <p className="text-sm text-zinc-300">
          Signed in as <span className="font-medium">{status.email}</span>
          {status.emailVerified ? null : <span className="ml-2 text-amber-300">— email not verified</span>}
        </p>
        {!status.emailVerified ? (
          claimed ? (
            <form onSubmit={(e) => void verifyEmail(e)} className="mt-2 flex flex-wrap items-end gap-2">
              <div>
                <label className="label" htmlFor="verify-existing">6-digit code</label>
                <input id="verify-existing" className="input" inputMode="numeric" value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} required />
              </div>
              <button className="btn-accent !px-3 !py-1 text-xs" disabled={busy}>{busy ? "Checking…" : "Verify"}</button>
            </form>
          ) : (
            <button type="button" className="btn mt-2 !px-3 !py-1 text-xs" disabled={busy} onClick={() => { setEmail(status.email ?? ""); setClaimed(true); void resend(); }}>
              Verify email
            </button>
          )
        ) : null}
        {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
        {notice ? <p className="mt-2 text-xs text-emerald-400">{notice}</p> : null}
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-400">Create an account</h2>
      <p className="mb-2 text-xs text-zinc-500">Sign in with a password next time, instead of waiting for a text code.</p>
      {claimed ? (
        <form onSubmit={(e) => void verifyEmail(e)} className="space-y-2">
          <div>
            <label className="label" htmlFor="verify-new">6-digit code</label>
            <input id="verify-new" className="input" inputMode="numeric" placeholder="123456" value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} autoFocus required />
            <p className="mt-1 text-xs text-zinc-500">Sent to {email}.</p>
          </div>
          {error ? <p className="text-xs text-red-400">{error}</p> : null}
          <button className="btn-accent !px-3 !py-1 text-xs" disabled={busy}>{busy ? "Checking…" : "Verify email"}</button>
        </form>
      ) : (
        <form onSubmit={(e) => void claim(e)} className="space-y-2">
          <div>
            <label className="label" htmlFor="claim-email">Email</label>
            <input id="claim-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="claim-password">Password</label>
            <input id="claim-password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
          </div>
          {error ? <p className="text-xs text-red-400">{error}</p> : null}
          <button className="btn-accent !px-3 !py-1 text-xs" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        </form>
      )}
    </div>
  );
}

function PackageCard({ pkg }: { pkg: CustomerPackageDto }): React.JSX.Element {
  return (
    <div className="card" data-testid={`my-package-${pkg.jobId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="mr-2 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{pkg.businessName}</span>
          <span className="text-sm font-semibold">
            {CUSTOMER_JOB_STATUS_LABELS[pkg.customerStatus as CustomerJobStatus] ?? pkg.customerStatus}
          </span>
        </div>
        {pkg.jobNumber ? <span className="text-xs text-zinc-500">{pkg.jobNumber}</span> : null}
      </div>
      <p className="mt-1 text-sm text-zinc-300">{pkg.itemSummary ?? "Your order"}</p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-zinc-400 sm:grid-cols-2">
        {pkg.amountExpected ? (
          <div className="flex justify-between gap-4">
            <dt>Amount</dt>
            <dd className="text-zinc-300">{formatMoney(pkg.amountExpected)}</dd>
          </div>
        ) : null}
        {pkg.riderName ? (
          <div className="flex justify-between gap-4">
            <dt>Courier</dt>
            <dd className="text-zinc-300">{pkg.riderName}</dd>
          </div>
        ) : null}
        {pkg.pin ? (
          <div className="flex justify-between gap-4">
            <dt>Delivery PIN</dt>
            <dd className="font-mono text-zinc-300">{pkg.pin}</dd>
          </div>
        ) : null}
      </dl>
      {pkg.location ? (
        <p className="mt-2 text-xs text-emerald-300">
          📍 {TRACKING_STATE_LABELS[pkg.location.trackingState]} — live location available
        </p>
      ) : null}
      {pkg.trackingUrl ? (
        <a href={pkg.trackingUrl} className="mt-2 inline-block text-xs text-brand-accent underline">
          Open full tracking →
        </a>
      ) : null}
    </div>
  );
}

import React, { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { API } from "@ronmacrae/contracts";
import { apiFetch, ApiError } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

/**
 * Public password reset for the shared login (staff, riders, anyone with
 * a User email). Two steps: request an emailed code, then redeem it with
 * a new password. The request step always reports success — it never
 * reveals whether an email has an account.
 */
export function ResetPassword(): React.JSX.Element {
  const { user, loading } = useAuth();
  const [step, setStep] = useState<"request" | "redeem" | "done">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) {
    return <Navigate to="/" replace />;
  }

  async function onRequest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch(API.auth.requestPasswordReset, { method: "POST", body: JSON.stringify({ email: email.trim() }) });
      setStep("redeem");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the reset email — is the API running?");
    } finally {
      setBusy(false);
    }
  }

  async function onRedeem(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch(API.auth.resetPassword, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), code: code.trim(), newPassword }),
      });
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset the password — is the API running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold text-brand-accent">Ronmacrae</div>
          <div className="text-xs uppercase tracking-[0.3em] text-zinc-400">Dispatch</div>
        </div>
        {step === "request" ? (
          <form onSubmit={(e) => void onRequest(e)} className="card space-y-4">
            <h1 className="text-lg font-bold">Reset your password</h1>
            <p className="text-sm text-zinc-400">Enter the email address you sign in with. If it has an account, we&apos;ll send a reset code.</p>
            <div>
              <label className="label" htmlFor="reset-email">Email</label>
              <input
                id="reset-email"
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
              />
            </div>
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <button className="btn-accent w-full" disabled={busy}>
              {busy ? "Sending…" : "Send reset code"}
            </button>
            <p className="text-center text-sm"><Link className="text-brand-accent underline" to="/login">Back to sign in</Link></p>
          </form>
        ) : step === "redeem" ? (
          <form onSubmit={(e) => void onRedeem(e)} className="card space-y-4">
            <h1 className="text-lg font-bold">Enter your code</h1>
            <p className="text-sm text-zinc-400">We sent a 6-digit code to {email.trim() || "your email"}. It expires in 10 minutes.</p>
            <div>
              <label className="label" htmlFor="reset-code">Code</label>
              <input
                id="reset-code"
                className="input"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="reset-new-password">New password (min 8 characters)</label>
              <input
                id="reset-new-password"
                className="input"
                type="password"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </div>
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <button className="btn-accent w-full" disabled={busy}>
              {busy ? "Resetting…" : "Set new password"}
            </button>
            <p className="text-center text-sm"><button type="button" className="text-brand-accent underline" onClick={() => { setError(null); setStep("request"); }}>Use a different email</button></p>
          </form>
        ) : (
          <div className="card space-y-4 text-center">
            <h1 className="text-lg font-bold">Password updated</h1>
            <p className="text-sm text-zinc-400">Your password is set. Every other session on this account was signed out.</p>
            <p className="text-sm"><Link className="text-brand-accent underline" to="/login">Sign in</Link></p>
          </div>
        )}
      </div>
    </div>
  );
}

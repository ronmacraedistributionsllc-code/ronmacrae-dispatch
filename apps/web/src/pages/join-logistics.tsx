import React, { useState } from "react";
import { API } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";

/** Public self-signup for a Bearer/Logistics Company — the shared-signup
 *  page's fourth account type (spec: "Customer, Courier, Merchant
 *  Business, and Bearer/Logistics Company"). Deliberately mirrors
 *  join-merchant.tsx's shape and flow exactly — same shared account
 *  system, same pending-until-approved application, same
 *  verify-then-wait-for-review steps. */
export function JoinLogistics(): React.JSX.Element {
  const [step, setStep] = useState<"form" | "verify" | "done">("form");
  const [ownerName, setOwnerName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await apiFetch(API.logisticsSignup.signup, { method: "POST", body: JSON.stringify({ ownerName, businessName, email, phone: phone || undefined, password }) });
      setStep("verify");
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        setStep("verify");
        setError("Your application was saved, but the verification email was not sent. Use Resend code below to try again.");
      } else setError(err instanceof ApiError ? err.message : "Could not submit your application");
    } finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await apiFetch(API.logisticsSignup.verify, { method: "POST", body: JSON.stringify({ email, code: code.trim() }) });
      setStep("done");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not verify that code"); }
    finally { setBusy(false); }
  }

  async function resend() {
    setError(null);
    try { await apiFetch(API.logisticsSignup.resend, { method: "POST", body: JSON.stringify({ email }) }); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not resend the code"); }
  }

  if (step === "done") return (
    <div className="flex min-h-dvh items-center justify-center p-4"><div className="card w-full max-w-md space-y-3 text-center">
      <h1 className="text-xl font-bold text-emerald-400">Application received</h1>
      <p className="text-sm text-zinc-300">Your email is verified. Ronmacrae will review <strong>{businessName}</strong> before activating your logistics company dashboard.</p>
      <p className="text-sm text-zinc-400">Once approved, sign in with {email} and the password you chose.</p>
      <a href="/login" className="btn-accent mt-2 inline-block">Back to sign in</a>
    </div></div>
  );

  if (step === "verify") return (
    <div className="flex min-h-dvh items-center justify-center p-4"><form onSubmit={(e) => void verify(e)} className="card w-full max-w-md space-y-4">
      <div className="text-center"><h1 className="text-xl font-bold text-brand-accent">Verify your account</h1><p className="text-sm text-zinc-400">Enter the code sent to {email}. Your application remains pending until approval.</p></div>
      <div><label className="label" htmlFor="ls-code">Verification code</label><input id="ls-code" className="input" inputMode="numeric" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} /></div>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <button className="btn-accent w-full" disabled={busy || code.trim().length < 4}>{busy ? "Verifying…" : "Verify email"}</button>
      <button type="button" className="w-full text-center text-xs text-zinc-500 underline" onClick={() => void resend()}>Resend code</button>
    </form></div>
  );

  return <div className="flex min-h-dvh items-center justify-center p-4"><form onSubmit={(e) => void submit(e)} className="card w-full max-w-md space-y-4">
    <div className="text-center"><h1 className="text-xl font-bold text-brand-accent">Sign up as Bearer/Logistics Company</h1><p className="text-sm text-zinc-400">Create a fleet-operator account to supply couriers for delivery work.</p></div>
    <div><label className="label" htmlFor="ls-owner">Your name</label><input id="ls-owner" className="input" required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} /></div>
    <div><label className="label" htmlFor="ls-business">Company name</label><input id="ls-business" className="input" required value={businessName} onChange={(e) => setBusinessName(e.target.value)} /></div>
    <div><label className="label" htmlFor="ls-email">Company owner email</label><input id="ls-email" type="email" className="input" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
    <div><label className="label" htmlFor="ls-phone">Phone</label><input id="ls-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
    <div><label className="label" htmlFor="ls-password">Choose a password</label><input id="ls-password" type="password" minLength={8} className="input" required value={password} onChange={(e) => setPassword(e.target.value)} /><p className="mt-1 text-xs text-zinc-500">Your password is stored only as a secure hash and is never emailed.</p></div>
    {error ? <p className="text-sm text-red-400">{error}</p> : null}
    <button className="btn-accent w-full" disabled={busy}>{busy ? "Submitting…" : "Submit application"}</button>
    <p className="text-center text-xs text-zinc-500"><a href="/login" className="underline">Back to sign in</a></p>
  </form></div>;
}

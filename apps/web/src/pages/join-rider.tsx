import React, { useState } from "react";
import { API } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";

/**
  * Public courier application — no login, no app (spec: "no way for a courier
 * to sign up which it should"). Two real steps, not just a form:
 *   1. Submit details -> lands as a `pending` RiderMembership.
 *   2. Prove ownership of the email just given (a code, valid 10 minutes)
 *      before the account can ever sign in at all — see auth.ts's login
  *      route, which blocks a courier with an unverified email outright.
 * Verifying the email is separate from a dispatcher approving the
 * application (Team screen) — both have to happen, in either order.
 */
export function JoinRider(): React.JSX.Element {
  const [step, setStep] = useState<"form" | "verify" | "done">("form");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [vehicle, setVehicle] = useState<"motorcycle" | "car">("motorcycle");
  const [plate, setPlate] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"pending" | "active">("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const canSubmit = name.trim().length > 0 && phone.replace(/[^\d]/g, "").length >= 7 && /\S+@\S+\.\S+/.test(email) && password.length >= 8;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch<{ status: "pending" | "active" }>(API.riders.signup, {
        method: "POST",
        body: JSON.stringify({ name, phone, email, vehicle, plate: plate || undefined, password }),
      });
      setStatus(res.status);
      setStep("verify");
    } catch (err) {
      if (err instanceof ApiError && err.status === 502) {
        // The application itself was created — only the email failed to
        // send. Move on to the verify step anyway (resubmitting this same
        // form would do the same thing server-side) so "Resend code" is
        // right there instead of leaving them stuck on a form that looks
        // like it silently did nothing.
        setStatus("pending");
        setStep("verify");
        setError("Your application was saved, but we couldn't email you a code just now — tap \"Resend code\" below to try again.");
      } else {
        setError(err instanceof ApiError ? err.message : "Could not submit your application");
      }
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch(API.riders.signupVerify, { method: "POST", body: JSON.stringify({ email, code: code.trim() }) });
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify that code");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    try {
      await apiFetch(API.riders.signupResend, { method: "POST", body: JSON.stringify({ email }) });
      setResent(true);
      setTimeout(() => setResent(false), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not resend the code");
    }
  }

  if (step === "done") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4">
        <div className="card w-full max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-bold text-emerald-400">Email verified</h1>
          <p className="text-sm text-zinc-300">
            {status === "active"
              ? "You're already approved and ready to go — sign in with your email and password."
              : "A dispatcher will review your application shortly. You'll be able to sign in once approved."}
          </p>
          <a href="/" className="btn-accent mt-2 inline-block">Back to sign-in</a>
        </div>
      </div>
    );
  }

  if (step === "verify") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4">
        <form onSubmit={(e) => void verify(e)} className="card w-full max-w-sm space-y-4">
          <div className="text-center">
            <h1 className="text-lg font-bold text-brand-accent">Check your email</h1>
            <p className="text-sm text-zinc-400">We sent a code to {email}. It expires in 10 minutes.</p>
          </div>
          <div>
            <label className="label" htmlFor="jr-code">Verification code</label>
            <input id="jr-code" className="input" inputMode="numeric" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button className="btn-accent w-full" disabled={busy || code.trim().length < 4}>{busy ? "Verifying…" : "Verify"}</button>
          <p className="text-center text-xs text-zinc-500">
            Didn't get it?{" "}
            <button type="button" className="underline" onClick={() => void resend()}>{resent ? "Sent!" : "Resend code"}</button>
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4">
      <form onSubmit={(e) => void submit(e)} className="card w-full max-w-sm space-y-4">
        <div className="text-center">
            <h1 className="text-lg font-bold text-brand-accent">Apply to become a courier</h1>
          <p className="text-sm text-zinc-400">A dispatcher reviews every application before you start.</p>
        </div>
        <div>
          <label className="label" htmlFor="jr-name">Full name</label>
          <input id="jr-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="jr-phone">Phone</label>
          <input id="jr-phone" className="input" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="876 555 1234" />
          <p className="mt-1 text-xs text-zinc-500">Used for coordination and messages — your email below is what you'll actually log in with.</p>
        </div>
        <div>
          <label className="label" htmlFor="jr-email">Email</label>
          <input id="jr-email" type="email" className="input" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="jr-vehicle">Vehicle</label>
          <select id="jr-vehicle" className="input" value={vehicle} onChange={(e) => setVehicle(e.target.value as "motorcycle" | "car")}>
            <option value="motorcycle">Motorcycle</option>
            <option value="car">Car</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="jr-plate">License plate (optional)</label>
          <input id="jr-plate" className="input" value={plate} onChange={(e) => setPlate(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="jr-password">Choose a password</label>
          <input id="jr-password" type="password" className="input" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">At least 8 characters. You'll use your email + this password to sign in once approved.</p>
        </div>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button className="btn-accent w-full" disabled={busy || !canSubmit}>{busy ? "Submitting…" : "Submit application"}</button>
        <p className="text-center text-xs text-zinc-500"><a href="/" className="underline">Back to sign-in</a></p>
      </form>
    </div>
  );
}

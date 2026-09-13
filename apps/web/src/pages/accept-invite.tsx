import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { API } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";

/**
 * Public invite-acceptance page (spec: "a real usable login/onboarding
 * flow—secure invite link or password setup"). The invite token in the
 * URL is the only credential needed to reach this page; what it asks for
 * next depends on whether this email already has an account (set a
 * password vs. just sign in normally — never overwrite an existing one).
 */
export function AcceptInvite(): React.JSX.Element {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"loading" | "invalid" | "form" | "done">("loading");
  const [invalidMessage, setInvalidMessage] = useState("");
  const [email, setEmail] = useState("");
  const [targetName, setTargetName] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setInvalidMessage("This invite link is missing its token.");
      setState("invalid");
      return;
    }
    apiFetch<{ email: string; name: string | null; targetName: string; needsPassword: boolean }>(API.invites.check(token))
      .then((res) => {
        setEmail(res.email);
        setName(res.name ?? "");
        setTargetName(res.targetName);
        setNeedsPassword(res.needsPassword);
        setState("form");
      })
      .catch((err) => {
        setInvalidMessage(err instanceof ApiError ? err.message : "This invite link isn't valid.");
        setState("invalid");
      });
  }, [token]);

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch(API.invites.accept, {
        method: "POST",
        body: JSON.stringify({ token, password: needsPassword ? password : undefined, name: needsPassword ? name || undefined : undefined }),
      });
      setState("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not accept this invite");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") {
    return <div className="flex h-dvh items-center justify-center text-sm text-zinc-400">Loading…</div>;
  }

  if (state === "invalid") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4">
        <div className="card w-full max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-bold text-red-400">Invite not valid</h1>
          <p className="text-sm text-zinc-300">{invalidMessage}</p>
          <a href="/" className="btn-accent mt-2 inline-block">Back to sign-in</a>
        </div>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4">
        <div className="card w-full max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-bold text-emerald-400">You're all set</h1>
          <p className="text-sm text-zinc-300">
            {needsPassword
              ? `Your account is ready — sign in with ${email} and the password you just chose.`
              : `${targetName} has been added to your existing account — sign in as usual to see it.`}
          </p>
          <a href="/" className="btn-accent mt-2 inline-block">Go to sign-in</a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-4">
      <form onSubmit={(e) => void accept(e)} className="card w-full max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-lg font-bold text-brand-accent">Join {targetName}</h1>
          <p className="text-sm text-zinc-400">{email}</p>
        </div>
        {needsPassword ? (
          <>
            <p className="text-sm text-zinc-300">Set a password to finish creating your account.</p>
            <div>
              <label className="label" htmlFor="ai-name">Your name</label>
              <input id="ai-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="ai-password">Choose a password</label>
              <input id="ai-password" type="password" className="input" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </>
        ) : (
          <p className="text-sm text-zinc-300">
            This email already has an account here. Accepting just adds {targetName} to it — your existing password stays
            the same.
          </p>
        )}
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button className="btn-accent w-full" disabled={busy || (needsPassword && password.length < 8)}>
          {busy ? "Joining…" : needsPassword ? "Set password & join" : "Accept invite"}
        </button>
      </form>
    </div>
  );
}

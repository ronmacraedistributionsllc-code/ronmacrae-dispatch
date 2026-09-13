import React, { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth.js";
import { ApiError } from "../lib/api.js";

export function Login(): React.JSX.Element {
  const { login, loading, user } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  if (!loading && user) {
    return (
      <div className="flex h-dvh items-center justify-center text-sm text-zinc-400">
        Redirecting…
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(identifier.trim(), password, totpCode.trim() || undefined);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Is the API running?");
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
        <form onSubmit={(e) => void onSubmit(e)} className="card space-y-4">
          <div>
            <label className="label" htmlFor="identifier">
              Email or phone
            </label>
            <input
              id="identifier"
              className="input"
              placeholder="admin@ronmacrae.example"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="totp">
              TOTP code (if enrolled)
            </label>
            <input
              id="totp"
              className="input"
              inputMode="numeric"
              placeholder="123456"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button className="btn-accent w-full" disabled={busy || loading}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-zinc-400">
          Want to ride with us? <a className="text-brand-accent underline" href="/join/rider">Apply to become a rider</a>
        </p>
      </div>
    </div>
  );
}

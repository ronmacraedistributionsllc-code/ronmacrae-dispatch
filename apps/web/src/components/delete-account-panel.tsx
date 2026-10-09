import React, { useState, type FormEvent } from "react";

/**
 * The one "delete my account" control every login face shares (main app,
 * merchant portal, logistics portal, customer dashboard) — each passes its
 * own `onDelete`, since each face authenticates differently. Plain words
 * about what happens, a typed confirmation, and the current password (the
 * server re-checks it; a stolen session alone can't erase an account).
 *
 * What it says must match what the API actually does (account-deletion.ts)
 * and what /privacy tells people — change them together.
 */
export function DeleteAccountPanel({
  onDelete,
  onDeleted,
  consequences,
}: {
  /** Throw an Error with a user-readable message to show it inline. */
  onDelete: (password: string) => Promise<void>;
  onDeleted: () => void;
  /** Face-specific extra line (e.g. what happens to a customer's orders). */
  consequences?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onDelete(password);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete your account — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <section className="card space-y-2" data-testid="delete-account">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Delete account</h2>
        <p className="text-sm text-zinc-400">Permanently close your account and sign out everywhere.</p>
        <button type="button" className="btn !border-red-800 !bg-red-950 text-red-300" onClick={() => setOpen(true)}>
          Delete my account…
        </button>
      </section>
    );
  }

  return (
    <section className="card space-y-3 !border-red-900" data-testid="delete-account">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-red-300">Delete account</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
        <li>You'll be signed out everywhere and won't be able to sign in again.</li>
        <li>Notifications to your devices stop.</li>
        <li>Past orders, deliveries and payment records stay with the businesses they belong to, so their books and disputes still add up.</li>
        {consequences ? <li>{consequences}</li> : null}
      </ul>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div>
          <label className="label" htmlFor="del-confirm">Type DELETE to confirm</label>
          <input id="del-confirm" className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor="del-password">Your password</label>
          <input id="del-password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
        <div className="flex gap-2">
          <button type="submit" className="btn !border-red-700 !bg-red-900 text-red-100" disabled={busy || confirmText !== "DELETE" || password.length === 0}>
            {busy ? "Deleting…" : "Permanently delete my account"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => { setOpen(false); setConfirmText(""); setPassword(""); setError(null); }}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

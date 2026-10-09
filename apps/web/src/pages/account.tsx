import React from "react";
import { useNavigate } from "react-router-dom";
import { API } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { DeleteAccountPanel } from "../components/delete-account-panel.js";

/** "My account" for every signed-in staff member and courier — one place
 *  that's reachable from the nav on every role, so account deletion is
 *  findable from inside the app (a store-review requirement), not buried
 *  in an admin-only screen. */
export function Account(): React.JSX.Element {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function onDelete(password: string): Promise<void> {
    try {
      await apiFetch(API.accountDeletion.main, { method: "POST", body: JSON.stringify({ password }) });
    } catch (err) {
      throw new Error(err instanceof ApiError ? err.message : "Could not delete your account — try again.");
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <header>
        <h1 className="text-xl font-bold">My account</h1>
        <p className="text-sm text-zinc-400">{user?.name} · {user?.email ?? user?.phone ?? "—"}</p>
      </header>
      <section className="card space-y-1 text-sm text-zinc-300">
        <p>
          Questions about your data?{" "}
          <a className="text-brand-accent underline" href="/privacy">Privacy policy</a> ·{" "}
          <a className="text-brand-accent underline" href="/support">Support</a>
        </p>
      </section>
      <DeleteAccountPanel
        onDelete={onDelete}
        onDeleted={() => {
          // The account is already gone server-side; this just clears the
          // local session + push registration and returns to sign-in.
          void logout().finally(() => navigate("/login", { replace: true }));
        }}
      />
    </div>
  );
}

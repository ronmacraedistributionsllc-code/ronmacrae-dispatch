import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "@ronmacrae/contracts";
import type { BusinessSettings } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

/**
 * Business settings — dispatch contact details and, notably, where the
 * "a new order came in" email alert goes (dispatchNotificationEmail). The
 * backend (`/api/settings/business`) already existed; there was simply no
 * screen for it, so nobody could actually turn this on.
 */
export function Settings(): React.JSX.Element {
  const { user } = useAuth();
  const canEdit = user?.role === "admin";
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["settings", "business"], queryFn: () => apiFetch<{ settings: BusinessSettings }>(API.settings.business) });
  const [form, setForm] = useState<BusinessSettings | null>(null);

  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  const save = useMutation({
    mutationFn: () => apiFetch(API.settings.updateBusiness, { method: "PUT", body: JSON.stringify(form) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings", "business"] }),
  });

  if (isLoading || !form) return <p className="text-sm text-zinc-400">Loading…</p>;
  const set = (patch: Partial<BusinessSettings>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="max-w-2xl space-y-4">
      <header>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-zinc-400">Business contact details and order-alert notifications.</p>
      </header>

      <form className="card space-y-4" onSubmit={(e) => { e.preventDefault(); void save.mutate(); }}>
        <div>
          <label className="label" htmlFor="st-name">Business name</label>
          <input id="st-name" className="input" required disabled={!canEdit} value={form.businessName} onChange={(e) => set({ businessName: e.target.value })} />
        </div>

        <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-3">
          <label className="label" htmlFor="st-dispatch-email">🔔 Order alert email</label>
          <input
            id="st-dispatch-email"
            type="email"
            className="input"
            disabled={!canEdit}
            value={form.dispatchNotificationEmail}
            onChange={(e) => set({ dispatchNotificationEmail: e.target.value })}
            placeholder="dispatch@yourbusiness.com"
          />
          <p className="mt-1 text-xs text-zinc-400">
            Sent immediately for every new order — merchant orders and direct/in-house orders alike — so dispatch never has to
            keep refreshing the Jobs screen to notice new work. Leave blank to turn this off.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="st-phone">Dispatch phone</label>
            <input id="st-phone" className="input" disabled={!canEdit} value={form.dispatchPhone} onChange={(e) => set({ dispatchPhone: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="st-whatsapp">Dispatch WhatsApp</label>
            <input id="st-whatsapp" className="input" disabled={!canEdit} value={form.dispatchWhatsApp} onChange={(e) => set({ dispatchWhatsApp: e.target.value })} />
            <p className="mt-1 text-xs text-zinc-500">Needs a connected WhatsApp/SMS provider (Twilio) to actually send — see BLOCKERS.md.</p>
          </div>
        </div>

        {!canEdit ? <p className="text-xs text-zinc-500">Only an admin can change these.</p> : null}
        {save.error ? <p className="text-sm text-red-400">{save.error instanceof ApiError ? save.error.message : "Could not save settings"}</p> : null}
        {save.isSuccess ? <p className="text-sm text-emerald-400">Saved.</p> : null}
        {canEdit ? <button className="btn-accent" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save settings"}</button> : null}
      </form>
    </div>
  );
}

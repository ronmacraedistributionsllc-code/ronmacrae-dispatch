import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "@ronmacrae/contracts";
import type { LogisticsCompanyDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

/**
 * Admin console for fleet-supplier clients (spec: "Bearer/Logistics
 * companies") — create a logistics company, grant it its own portal
 * login, disable it. Mirrors merchants.tsx closely; the real difference is
 * there's no public storefront/QR code here — a logistics company
 * supplies riders, not orders, so nothing customer-facing to link to.
 * Which riders are attached to a company is a Platform Admin decision
 * (see platform-admin.tsx's rider attachment controls), not set here.
 */
export function LogisticsCompanies(): React.JSX.Element {
  const { user } = useAuth();
  const canEdit = user?.role === "admin";
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const list = useQuery({ queryKey: ["logisticsCompanies"], queryFn: () => apiFetch<{ logisticsCompanies: LogisticsCompanyDto[] }>(API.logisticsCompanies.list) });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Logistics companies</h1>
          <p className="text-sm text-zinc-400">Fleet operators who supply their own riders — the other side of the marketplace from merchants.</p>
        </div>
        {canEdit ? (
          <button className="btn-accent" onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New logistics company"}</button>
        ) : null}
      </header>

      {creating ? <CreateForm onDone={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ["logisticsCompanies"] }); }} /> : null}

      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {list.data && list.data.logisticsCompanies.length === 0 ? (
        <div className="card text-sm text-zinc-400">No logistics companies yet — create one, then grant it a portal login and have Platform Admin attach riders to it.</div>
      ) : null}
      <div className="space-y-3">
        {list.data?.logisticsCompanies.map((c) => (
          <CompanyRow key={c.id} company={c} canEdit={canEdit} onChanged={() => void qc.invalidateQueries({ queryKey: ["logisticsCompanies"] })} />
        ))}
      </div>
    </div>
  );
}

function CreateForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const create = useMutation({
    mutationFn: () => apiFetch(API.logisticsCompanies.create, { method: "POST", body: JSON.stringify({ name, phone: phone || undefined, email: email || undefined }) }),
    onSuccess: onDone,
  });
  return (
    <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); void create.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="lc-name">Company name</label>
          <input id="lc-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Swift Riders Ltd" />
        </div>
        <div>
          <label className="label" htmlFor="lc-phone">Phone (optional)</label>
          <input id="lc-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="lc-email">Contact email (optional)</label>
          <input id="lc-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      {create.error ? <p className="text-sm text-red-400">{create.error instanceof ApiError ? create.error.message : "Could not create logistics company"}</p> : null}
      <button className="btn-accent" disabled={create.isPending || !name.trim()}>{create.isPending ? "Creating…" : "Create logistics company"}</button>
    </form>
  );
}

function CompanyRow({ company, canEdit, onChanged }: { company: LogisticsCompanyDto; canEdit: boolean; onChanged: () => void }): React.JSX.Element {
  const [showPortalForm, setShowPortalForm] = useState(false);
  const toggleActive = useMutation({
    mutationFn: () => apiFetch(API.logisticsCompanies.update(company.id), { method: "PATCH", body: JSON.stringify({ active: !company.active }) }),
    onSuccess: onChanged,
  });

  return (
    <section className={`card space-y-2 ${company.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">{company.name}</h2>
          <p className="text-xs text-zinc-500">{company.riderCount} attached rider{company.riderCount === 1 ? "" : "s"} · {company.phone ?? company.email ?? "No contact on file"}</p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${company.active ? "bg-emerald-900/50 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
          {company.active ? "Active" : "Disabled"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <button type="button" className="btn !px-3 !py-1 text-xs" disabled={toggleActive.isPending} onClick={() => void toggleActive.mutate()}>
            {company.active ? "Disable" : "Re-enable"}
          </button>
        ) : null}
        {canEdit ? (
          <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => setShowPortalForm((v) => !v)}>
            {showPortalForm ? "Cancel" : "Portal access"}
          </button>
        ) : null}
      </div>
      {showPortalForm ? <GrantPortalAccessForm companyId={company.id} onDone={() => setShowPortalForm(false)} /> : null}
    </section>
  );
}

function GrantPortalAccessForm({ companyId, onDone }: { companyId: string; onDone: () => void }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const grant = useMutation({
    mutationFn: () => apiFetch<{ reusedExistingAccount: boolean }>(API.logisticsCompanies.grantStaff(companyId), { method: "POST", body: JSON.stringify({ email, name: name || undefined, password: password || undefined }) }),
    onSuccess: onDone,
  });
  return (
    <form className="space-y-2 rounded-lg border border-zinc-700 p-3" onSubmit={(e) => { e.preventDefault(); void grant.mutate(); }}>
      <p className="text-xs text-zinc-400">
        Lets this person sign in (the same sign-in page everyone uses) to view this company's fleet dashboard. If this
        email already has an account (staff, rider, merchant, or another logistics company), this just adds this
        company to it — their existing password is never changed.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className="input" type="email" required placeholder="Login email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" placeholder="Contact name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" type="password" minLength={8} placeholder="Password (only if new account)" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {grant.error ? <p className="text-sm text-red-400">{grant.error instanceof ApiError ? grant.error.message : "Could not grant access"}</p> : null}
      {grant.isSuccess ? <p className="text-sm text-emerald-400">Access granted.</p> : null}
      <button className="btn-accent !px-3 !py-1 text-xs" disabled={grant.isPending || !email}>{grant.isPending ? "Saving…" : "Grant access"}</button>
    </form>
  );
}

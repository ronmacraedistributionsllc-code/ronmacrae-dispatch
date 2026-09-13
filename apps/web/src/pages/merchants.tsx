import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "@ronmacrae/contracts";
import type { MerchantDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

/**
 * Admin console for store/merchant clients (spec section 3/4/49) — create a
 * merchant, get its public order link + QR code, disable it, edit contact
 * details. Creating/editing is owner(admin)-only; dispatchers can view.
 */
export function Merchants(): React.JSX.Element {
  const { user } = useAuth();
  const canEdit = user?.role === "admin";
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const list = useQuery({ queryKey: ["merchants"], queryFn: () => apiFetch<{ merchants: MerchantDto[] }>(API.merchants.list) });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Merchants</h1>
          <p className="text-sm text-zinc-400">Store clients with their own public order link — e.g. "VBR Basics".</p>
        </div>
        {canEdit ? (
          <button className="btn-accent" onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New merchant"}</button>
        ) : null}
      </header>

      {creating ? <CreateMerchantForm onDone={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ["merchants"] }); }} /> : null}

      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {list.data && list.data.merchants.length === 0 ? (
        <div className="card text-sm text-zinc-400">No merchants yet — create one to get a public order link like /order/your-store-name.</div>
      ) : null}
      <div className="space-y-3">
        {list.data?.merchants.map((m) => (
          <MerchantRow key={m.id} merchant={m} canEdit={canEdit} onChanged={() => void qc.invalidateQueries({ queryKey: ["merchants"] })} />
        ))}
      </div>
    </div>
  );
}

function CreateMerchantForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notificationEmails, setNotificationEmails] = useState("");
  const [pickupAddressText, setPickupAddressText] = useState("");
  const create = useMutation({
    mutationFn: () => apiFetch(API.merchants.create, { method: "POST", body: JSON.stringify({ name, phone: phone || undefined, notificationEmails: notificationEmails || undefined, pickupAddressText: pickupAddressText || undefined }) }),
    onSuccess: onDone,
  });
  return (
    <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); void create.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="m-name">Store name</label>
          <input id="m-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. VBR Basics" />
        </div>
        <div>
          <label className="label" htmlFor="m-phone">Phone (optional)</label>
          <input id="m-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="m-emails">Order notification email(s)</label>
          <input id="m-emails" className="input" value={notificationEmails} onChange={(e) => setNotificationEmails(e.target.value)} placeholder="owner@store.com, manager@store.com" />
          <p className="mt-1 text-xs text-zinc-500">A new-order email is sent here immediately when a customer orders.</p>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="m-pickup">Pickup address (optional — used to calculate delivery fees)</label>
          <input id="m-pickup" className="input" value={pickupAddressText} onChange={(e) => setPickupAddressText(e.target.value)} placeholder="Where riders collect orders for this store" />
        </div>
      </div>
      {create.error ? <p className="text-sm text-red-400">{create.error instanceof ApiError ? create.error.message : "Could not create merchant"}</p> : null}
      <button className="btn-accent" disabled={create.isPending || !name.trim()}>{create.isPending ? "Creating…" : "Create merchant"}</button>
    </form>
  );
}

function MerchantRow({ merchant, canEdit, onChanged }: { merchant: MerchantDto; canEdit: boolean; onChanged: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showPortalForm, setShowPortalForm] = useState(false);
  const toggleActive = useMutation({
    mutationFn: () => apiFetch(API.merchants.update(merchant.id), { method: "PATCH", body: JSON.stringify({ active: !merchant.active }) }),
    onSuccess: onChanged,
  });
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(merchant.orderUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — the link is still shown/selectable below
    }
  };
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(merchant.orderUrl)}`;

  return (
    <section className={`card space-y-2 ${merchant.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">{merchant.name}</h2>
          <p className="text-xs text-zinc-500">{merchant.notificationEmails.length > 0 ? merchant.notificationEmails.join(", ") : "No notification email configured yet"}</p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${merchant.active ? "bg-emerald-900/50 text-emerald-300" : "bg-zinc-800 text-zinc-500"}`}>
          {merchant.active ? "Active" : "Disabled"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a className="input min-w-60 flex-1 truncate !text-sky-300 hover:!border-sky-700" href={merchant.orderUrl} target="_blank" rel="noreferrer">
          {merchant.orderUrl}
        </a>
        <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => void copyLink()}>{copied ? "Copied!" : "Copy link"}</button>
        <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => setShowQr((v) => !v)}>{showQr ? "Hide QR" : "QR code"}</button>
        {canEdit ? (
          <button type="button" className="btn !px-3 !py-1 text-xs" disabled={toggleActive.isPending} onClick={() => void toggleActive.mutate()}>
            {merchant.active ? "Disable link" : "Re-enable link"}
          </button>
        ) : null}
        {canEdit ? (
          <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => setShowPortalForm((v) => !v)}>
            {showPortalForm ? "Cancel" : "Portal access"}
          </button>
        ) : null}
      </div>
      {showQr ? (
        <div className="flex flex-col items-start gap-1">
          <img src={qrSrc} alt={`QR code for ${merchant.orderUrl}`} width={220} height={220} className="rounded border border-zinc-700 bg-white p-2" />
          <p className="text-xs text-zinc-500">Print this or share it — scanning opens this store's order form directly.</p>
        </div>
      ) : null}
      {showPortalForm ? <GrantPortalAccessForm merchantId={merchant.id} onDone={() => setShowPortalForm(false)} /> : null}
    </section>
  );
}

function GrantPortalAccessForm({ merchantId, onDone }: { merchantId: string; onDone: () => void }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const grant = useMutation({
    mutationFn: () => apiFetch(API.merchants.grantStaff(merchantId), { method: "POST", body: JSON.stringify({ email, name: name || undefined, password }) }),
    onSuccess: onDone,
  });
  return (
    <form className="space-y-2 rounded-lg border border-zinc-700 p-3" onSubmit={(e) => { e.preventDefault(); void grant.mutate(); }}>
      <p className="text-xs text-zinc-400">Lets this store sign in at <code>/merchant</code> to view their own orders.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className="input" type="email" required placeholder="Login email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" placeholder="Contact name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" type="password" required minLength={8} placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {grant.error ? <p className="text-sm text-red-400">{grant.error instanceof ApiError ? grant.error.message : "Could not grant access"}</p> : null}
      {grant.isSuccess ? <p className="text-sm text-emerald-400">Access granted — share the email/password with them directly.</p> : null}
      <button className="btn-accent !px-3 !py-1 text-xs" disabled={grant.isPending || !email || password.length < 8}>{grant.isPending ? "Saving…" : "Grant access"}</button>
    </form>
  );
}

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API, MONEY_TRANSFER_LABELS } from "@ronmacrae/contracts";
import type { MerchantDto, MoneyTransferDto, RiderDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";

function fmtMinor(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

const STATUS_LABEL: Record<MoneyTransferDto["status"], string> = {
  pending: "Waiting — nobody confirmed yet",
  awaiting_other_side: "One side confirmed — waiting on the other",
  confirmed: "Paid + received ✓",
  disputed: "Disputed — needs resolution",
};

/**
 * Money ledger — who owes what, and whether BOTH sides agreed. Every row
 * needs two confirmations ("I paid" + "I received"); one-sided rows sit
 * here visibly instead of in someone's memory. Staff create payouts and
 * settlements; COD handovers appear automatically on delivery.
 */
export function Money(): React.JSX.Element {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const list = useQuery({
    queryKey: ["money-transfers", status],
    queryFn: () => apiFetch<{ transfers: MoneyTransferDto[] }>(`${API.money.list}${status ? `?status=${status}` : ""}`),
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["money-transfers"] });

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-xl font-bold">Money</h1>
        <p className="text-sm text-zinc-400">Every transfer needs both sides: the payer confirms “I paid”, the receiver confirms “I received”. Nothing counts as done until both.</p>
      </header>
      <CreateTransferForm onCreated={invalidate} />
      <div className="flex gap-2 text-xs">
        {(["", "pending", "awaiting_other_side", "confirmed", "disputed"] as const).map((s) => (
          <button key={s || "all"} type="button" className={`btn !px-3 !py-1 ${status === s ? "!border-emerald-700" : ""}`} onClick={() => setStatus(s)}>
            {s === "" ? "All" : STATUS_LABEL[s].split(" — ")[0]}
          </button>
        ))}
      </div>
      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {(list.data?.transfers.length ?? 1) === 0 ? <p className="text-sm text-zinc-500">No transfers in this state.</p> : null}
      <div className="space-y-2">
        {list.data?.transfers.map((t) => <TransferRow key={t.id} transfer={t} onChanged={invalidate} />)}
      </div>
    </div>
  );
}

function partyLabel(t: MoneyTransferDto, side: "from" | "to"): string {
  const kind = side === "from" ? t.fromKind : t.toKind;
  const rider = side === "from" ? t.fromRider : t.toRider;
  if (kind === "rider") return rider?.name ?? "Courier";
  if (kind === "merchant") return "Merchant";
  return "Business";
}

function TransferRow({ transfer: t, onChanged }: { transfer: MoneyTransferDto; onChanged: () => void }): React.JSX.Element {
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");
  const confirm = useMutation({
    mutationFn: (side: "paid" | "received") => apiFetch(API.money.confirm(t.id), { method: "POST", body: JSON.stringify({ side }) }),
    onSuccess: onChanged,
  });
  const dispute = useMutation({
    mutationFn: () => apiFetch(API.money.dispute(t.id), { method: "POST", body: JSON.stringify({ note: note.trim() }) }),
    onSuccess: () => { setDisputing(false); setNote(""); onChanged(); },
  });
  const err = confirm.error ?? dispute.error;
  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{MONEY_TRANSFER_LABELS[t.kind]} · {fmtMinor(t.amount, t.currency)}</p>
          <p className="text-xs text-zinc-500">{partyLabel(t, "from")} → {partyLabel(t, "to")}{t.job?.jobNumber ? ` · order ${t.job.jobNumber}` : ""}</p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${t.status === "confirmed" ? "bg-emerald-900/50 text-emerald-300" : t.status === "disputed" ? "bg-red-900/50 text-red-300" : "bg-amber-900/50 text-amber-300"}`}>
          {STATUS_LABEL[t.status]}
        </span>
      </div>
      {t.note ? <p className="text-xs text-zinc-400">{t.note}</p> : null}
      {t.status !== "confirmed" && t.status !== "disputed" ? (
        <div className="flex flex-wrap gap-2">
          {!t.payerConfirmedAt ? (
            <button type="button" className="btn !px-3 !py-1 text-xs" disabled={confirm.isPending} onClick={() => void confirm.mutate("paid")}>
              I paid {fmtMinor(t.amount, t.currency)}
            </button>
          ) : (
            <span className="text-xs text-zinc-500">✓ Paid{t.receiverConfirmedAt ? "" : " — waiting on receipt"}</span>
          )}
          {!t.receiverConfirmedAt ? (
            <button type="button" className="btn !px-3 !py-1 text-xs" disabled={confirm.isPending} onClick={() => void confirm.mutate("received")}>
              I received {fmtMinor(t.amount, t.currency)}
            </button>
          ) : (
            <span className="text-xs text-zinc-500">✓ Received</span>
          )}
          <button type="button" className="btn !px-3 !py-1 text-xs !text-red-300" onClick={() => setDisputing((v) => !v)}>Dispute</button>
        </div>
      ) : null}
      {disputing ? (
        <div className="flex gap-2">
          <input className="input" placeholder="What went wrong?" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn !px-3 !py-1 text-xs !border-red-800 !text-red-300" disabled={dispute.isPending || note.trim() === ""} onClick={() => void dispute.mutate()}>
            Send dispute
          </button>
        </div>
      ) : null}
      {err ? <p className="text-sm text-red-400">{err instanceof ApiError ? err.message : "Could not update"}</p> : null}
    </div>
  );
}

function CreateTransferForm({ onCreated }: { onCreated: () => void }): React.JSX.Element {
  const [kind, setKind] = useState<"courier_payout" | "merchant_settlement">("courier_payout");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const riders = useQuery({ queryKey: ["riders"], queryFn: () => apiFetch<{ riders: RiderDto[] }>(API.riders.list) });
  const merchants = useQuery({ queryKey: ["merchants"], queryFn: () => apiFetch<{ merchants: MerchantDto[] }>(API.merchants.list) });
  const create = useMutation({
    mutationFn: () => apiFetch(API.money.create, {
      method: "POST",
      body: JSON.stringify({
        kind,
        ...(kind === "courier_payout" ? { toRiderId: toId } : { toMerchantId: toId }),
        amount: Number(amount),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    }),
    onSuccess: () => { setToId(""); setAmount(""); setNote(""); onCreated(); },
  });
  const options = kind === "courier_payout" ? (riders.data?.riders ?? []).map((r) => ({ id: r.id, name: r.name })) : (merchants.data?.merchants ?? []).map((m) => ({ id: m.id, name: m.name }));
  return (
    <details className="card space-y-2">
      <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-zinc-400">Record a payout or settlement</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="mt-kind">Type</label>
          <select id="mt-kind" className="input" value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setToId(""); }}>
            <option value="courier_payout">Pay a courier</option>
            <option value="merchant_settlement">Settle with a merchant</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="mt-to">{kind === "courier_payout" ? "Courier" : "Merchant"}</label>
          <select id="mt-to" className="input" value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="mt-amount">Amount</label>
          <input id="mt-amount" className="input" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="mt-note">Note (optional)</label>
          <input id="mt-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      {create.error ? <p className="text-sm text-red-400">{create.error instanceof ApiError ? create.error.message : "Could not record"}</p> : null}
      <button type="button" className="btn-accent" disabled={create.isPending || !toId || !(Number(amount) > 0)} onClick={() => void create.mutate()}>
        {create.isPending ? "Recording…" : "Record — still needs both confirmations"}
      </button>
    </details>
  );
}

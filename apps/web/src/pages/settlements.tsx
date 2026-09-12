import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "@ronmacrae/contracts";
import type { RiderDto, SettlementDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";

interface OutstandingMerchant {
  merchantId: string | null;
  merchantName: string;
  total: { amount: number; currency: string };
  jobs: { jobId: string; jobNumber: string | null; amount: { amount: number; currency: string } }[];
}

/**
 * End-of-day rider reconciliation (spec section 42/90): pick a rider, see
 * exactly whose cash they're holding and how much, settle one merchant's
 * outstanding jobs at a time. The amount is always what the server computes
 * from the jobs actually selected — never typed in directly.
 */
export function Settlements(): React.JSX.Element {
  const qc = useQueryClient();
  const [riderId, setRiderId] = useState("");

  const riders = useQuery({ queryKey: ["riders"], queryFn: () => apiFetch<{ riders: RiderDto[] }>("/riders") });
  const outstanding = useQuery({
    queryKey: ["settlements-outstanding", riderId],
    queryFn: () => apiFetch<{ merchants: OutstandingMerchant[] }>(API.settlements.outstanding(riderId)),
    enabled: Boolean(riderId),
  });
  const recent = useQuery({
    queryKey: ["settlements", riderId],
    queryFn: () => apiFetch<{ settlements: SettlementDto[] }>(`${API.settlements.list}?riderId=${riderId}`),
    enabled: Boolean(riderId),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["settlements-outstanding", riderId] });
    void qc.invalidateQueries({ queryKey: ["settlements", riderId] });
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Settlements</h1>
        <p className="text-sm text-zinc-400">Record cash a rider hands in — broken down by which merchant it belongs to.</p>
      </header>

      <section className="card">
        <label className="label" htmlFor="settle-rider">Rider</label>
        <select id="settle-rider" className="input max-w-sm" value={riderId} onChange={(e) => setRiderId(e.target.value)}>
          <option value="">Choose a rider…</option>
          {riders.data?.riders.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </section>

      {riderId && outstanding.data ? (
        <>
          {outstanding.data.merchants.length === 0 ? (
            <div className="card text-sm text-zinc-400">Nothing outstanding for this rider right now.</div>
          ) : (
            <div className="space-y-3">
              {outstanding.data.merchants.map((m) => (
                <MerchantOutstandingCard key={m.merchantId ?? "direct"} riderId={riderId} merchant={m} onSettled={refresh} />
              ))}
            </div>
          )}

          {recent.data && recent.data.settlements.length > 0 ? (
            <section className="card">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Recent settlements</h2>
              <ul className="divide-y divide-zinc-800 text-sm">
                {recent.data.settlements.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="text-zinc-300">{s.merchantName ?? "Direct orders"} · {s.jobIds.length} order{s.jobIds.length === 1 ? "" : "s"}</span>
                    <span className="text-zinc-200">{formatMoney(s.amount)}</span>
                    <span className="text-xs text-zinc-500">{new Date(s.createdAt).toLocaleString("en-JM", { dateStyle: "medium", timeStyle: "short" })} · received by {s.receivedByName}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function MerchantOutstandingCard({ riderId, merchant, onSettled }: { riderId: string; merchant: OutstandingMerchant; onSettled: () => void }): React.JSX.Element {
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const settle = useMutation({
    mutationFn: () =>
      apiFetch(API.settlements.create, {
        method: "POST",
        body: JSON.stringify({ riderId, merchantId: merchant.merchantId, type: "full", jobIds: merchant.jobs.map((j) => j.jobId), reference: reference || undefined, note: note || undefined }),
      }),
    onSuccess: () => { setReference(""); setNote(""); onSettled(); },
  });

  return (
    <section className="card space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{merchant.merchantName}</h2>
        <span className="font-semibold text-amber-200">{formatMoney(merchant.total)}</span>
      </div>
      <p className="text-xs text-zinc-500">{merchant.jobs.length} order{merchant.jobs.length === 1 ? "" : "s"} handed in, awaiting approval</p>
      <ul className="text-xs text-zinc-400">
        {merchant.jobs.map((j) => (
          <li key={j.jobId} className="flex justify-between py-0.5">
            <span>{j.jobNumber ?? j.jobId.slice(0, 8)}</span>
            <span>{formatMoney(j.amount)}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-40">
          <label className="label" htmlFor={`ref-${merchant.merchantId ?? "direct"}`}>Reference (optional)</label>
          <input id={`ref-${merchant.merchantId ?? "direct"}`} className="input !py-1" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. cash drawer #1" />
        </div>
        <div className="min-w-40 flex-1">
          <label className="label" htmlFor={`note-${merchant.merchantId ?? "direct"}`}>Note (optional)</label>
          <input id={`note-${merchant.merchantId ?? "direct"}`} className="input !py-1" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button className="btn-accent !py-1.5" disabled={settle.isPending} onClick={() => void settle.mutate()}>
          {settle.isPending ? "Recording…" : `Confirm settlement — ${formatMoney(merchant.total)}`}
        </button>
      </div>
      {settle.error ? <p className="text-sm text-red-400">{settle.error instanceof ApiError ? settle.error.message : "Could not record this settlement"}</p> : null}
    </section>
  );
}

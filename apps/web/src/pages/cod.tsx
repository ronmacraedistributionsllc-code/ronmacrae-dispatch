import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodStatus, JobSummaryDto } from "@ronmacrae/contracts";
import { API } from "@ronmacrae/contracts";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

const STATUS_LABEL: Record<CodStatus, string> = {
  pending_collection: "Pending collection",
  collected: "Collected",
  handed_in: "Handed in",
  disputed: "Disputed",
  approved: "Approved",
};
const STATUS_BADGE: Record<CodStatus, string> = {
  pending_collection: "bg-zinc-800 text-zinc-300",
  collected: "bg-sky-900/50 text-sky-300",
  handed_in: "bg-amber-900/40 text-amber-300",
  disputed: "bg-red-900/60 text-red-200",
  approved: "bg-emerald-900/50 text-emerald-300",
};
const FILTERS: { value: CodStatus | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "pending_collection", label: "Pending collection" },
  { value: "collected", label: "Collected" },
  { value: "handed_in", label: "Awaiting approval" },
  { value: "disputed", label: "Disputed" },
  { value: "approved", label: "Approved" },
];

function variance(job: JobSummaryDto): number | null {
  if (job.codHandedInAmount == null || job.amountCollected == null) return null;
  return job.codHandedInAmount.amount - job.amountCollected.amount;
}

/**
 * Dispatcher/owner/accountant board for the COD reconciliation ledger
 * (spec 5A). Dispatcher/owner monitor; accountant/owner approve or dispute.
 * Customers never reach this page (it's under the staff-only Layout), and
 * nothing here is exposed via the public tracking page either.
 */
export function CodReconciliation(): React.JSX.Element {
  const { user } = useAuth();
  const canDecide = user?.role === "admin" || user?.role === "accountant";
  const [status, setStatus] = useState<CodStatus | "">("");
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ["cod", status],
    queryFn: () => apiFetch<{ jobs: JobSummaryDto[]; total: number }>(`${API.cod.list}${status ? `?status=${status}` : ""}`),
    refetchInterval: 20_000,
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">COD reconciliation</h1>
        <p className="text-sm text-zinc-400">
          Cash collected from customers vs. what riders have handed in to the office — separate from delivery fees or rider earnings.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            className={status === f.value ? "btn-accent !px-3 !py-1 text-xs" : "btn !px-3 !py-1 text-xs"}
            onClick={() => setStatus(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {list.data && list.data.jobs.length === 0 ? <section className="card text-sm text-zinc-400">No COD jobs match this filter.</section> : null}
      <div className="space-y-2">
        {list.data?.jobs.map((job) => (
          <CodRow key={job.id} job={job} canDecide={canDecide} onChanged={() => void qc.invalidateQueries({ queryKey: ["cod"] })} />
        ))}
      </div>
    </div>
  );
}

function CodRow({ job, canDecide, onChanged }: { job: JobSummaryDto; canDecide: boolean; onChanged: () => void }): React.JSX.Element {
  const [note, setNote] = useState("");
  const [showDispute, setShowDispute] = useState(false);
  const approve = useMutation({
    mutationFn: () => apiFetch(API.cod.approve(job.id), { method: "POST", body: JSON.stringify({ note: note || undefined }) }),
    onSuccess: () => { setNote(""); onChanged(); },
  });
  const dispute = useMutation({
    mutationFn: () => apiFetch(API.cod.dispute(job.id), { method: "POST", body: JSON.stringify({ note }) }),
    onSuccess: () => { setNote(""); setShowDispute(false); onChanged(); },
  });
  const v = variance(job);
  const canAct = canDecide && (job.codStatus === "collected" || job.codStatus === "handed_in" || job.codStatus === "disputed");
  const error = approve.error ?? dispute.error;

  return (
    <section className="card space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{job.jobNumber ?? job.id.slice(0, 8)}</h2>
          <p className="text-xs text-zinc-400">{job.customerName} · {job.riderName ?? "Unassigned"}</p>
        </div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[job.codStatus]}`}>{STATUS_LABEL[job.codStatus]}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div><dt className="label !mb-0">Expected</dt><dd className="text-zinc-200">{formatMoney(job.amountExpected)}</dd></div>
        <div><dt className="label !mb-0">Collected</dt><dd className="text-zinc-200">{formatMoney(job.amountCollected)}</dd></div>
        <div><dt className="label !mb-0">Handed in</dt><dd className="text-zinc-200">{formatMoney(job.codHandedInAmount)}</dd></div>
        <div>
          <dt className="label !mb-0">Variance</dt>
          <dd className={v == null ? "text-zinc-500" : v < 0 ? "text-red-400" : v > 0 ? "text-amber-300" : "text-zinc-200"}>
            {v == null ? "—" : formatMoney({ amount: Math.abs(v), currency: job.amountExpected?.currency ?? "JMD" })}
            {v != null && v !== 0 ? (v < 0 ? " short" : " over") : null}
          </dd>
        </div>
      </dl>
      {error ? <p className="text-sm text-red-400">{error instanceof ApiError ? error.message : "Action failed"}</p> : null}
      {canAct ? (
        <div className="space-y-2">
          {showDispute ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <label className="label" htmlFor={`note-${job.id}`}>Reason for dispute</label>
                <input id={`note-${job.id}`} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. amount doesn't match handover" />
              </div>
              <button className="btn !px-3 !py-1 text-xs" disabled={dispute.isPending || note.trim() === ""} onClick={() => void dispute.mutate()}>
                {dispute.isPending ? "Saving…" : "Confirm dispute"}
              </button>
              <button className="btn !px-3 !py-1 text-xs" onClick={() => setShowDispute(false)}>Cancel</button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button className="btn-accent !px-3 !py-1 text-xs" disabled={approve.isPending} onClick={() => void approve.mutate()}>
                {approve.isPending ? "Saving…" : "Approve"}
              </button>
              <button className="btn !px-3 !py-1 text-xs" onClick={() => setShowDispute(true)}>Dispute</button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

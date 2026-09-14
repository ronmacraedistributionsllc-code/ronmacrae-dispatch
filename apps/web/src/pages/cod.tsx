import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodDisputeType, CodStatus, CodSummaryDto, JobSummaryDto } from "@ronmacrae/contracts";
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
const DISPUTE_TYPE_LABEL: Record<CodDisputeType, string> = { shortage: "Shortage", overage: "Overage", other: "Other" };
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
 * (spec 5A, extended Stage 38 with an explicit dispute category and an
 * archival workflow for settled entries). Dispatcher/owner monitor;
 * accountant/owner approve, dispute, or archive/unarchive. Customers never
 * reach this page (it's under the staff-only Layout), and nothing here is
 * exposed via the public tracking page either.
 */
export function CodReconciliation(): React.JSX.Element {
  const { user } = useAuth();
  // Approve is dispatch's day-to-day job (they're the one actually handed the
  // cash); dispute/archive stay an accountant/admin-only escalation — see
  // cod.ts's matching split between `approver` and `disputer`.
  const canApprove = user?.role === "admin" || user?.role === "dispatcher" || user?.role === "accountant";
  const canDispute = user?.role === "admin" || user?.role === "accountant";
  const [status, setStatus] = useState<CodStatus | "">("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ["cod", status, includeArchived],
    queryFn: () => apiFetch<{ jobs: JobSummaryDto[]; total: number }>(
      `${API.cod.list}?${new URLSearchParams({ ...(status ? { status } : {}), ...(includeArchived ? { includeArchived: "true" } : {}) })}`,
    ),
    refetchInterval: 20_000,
  });
  const summary = useQuery({ queryKey: ["cod", "summary"], queryFn: () => apiFetch<CodSummaryDto>(API.cod.summary), refetchInterval: 30_000 });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">COD reconciliation</h1>
        <p className="text-sm text-zinc-400">
          Cash collected from customers vs. what couriers have handed in to the office — separate from delivery fees or courier earnings.
        </p>
      </header>

      {summary.data ? (
        <section className="card">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Shortage / overage, all time</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="label !mb-0">Total shortage</dt>
              <dd className="text-red-400">{formatMoney(summary.data.shortage)} <span className="text-zinc-500">({summary.data.shortageCount})</span></dd>
            </div>
            <div>
              <dt className="label !mb-0">Total overage</dt>
              <dd className="text-amber-300">{formatMoney(summary.data.overage)} <span className="text-zinc-500">({summary.data.overageCount})</span></dd>
            </div>
            <div>
              <dt className="label !mb-0">Matched handovers</dt>
              <dd className="text-zinc-200">{summary.data.matchedCount}</dd>
            </div>
            {summary.data.disputedBeforeHandoverCount > 0 ? (
              <div>
                <dt className="label !mb-0">Disputed before hand-in</dt>
                <dd className="text-zinc-200">{summary.data.disputedBeforeHandoverCount}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
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
        {canDispute ? (
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            Include archived
          </label>
        ) : null}
      </div>
      {list.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {list.data && list.data.jobs.length === 0 ? <section className="card text-sm text-zinc-400">No COD jobs match this filter.</section> : null}
      <div className="space-y-2">
        {list.data?.jobs.map((job) => (
          <CodRow
            key={job.id}
            job={job}
            canApprove={canApprove}
            canDispute={canDispute}
            onChanged={() => {
              void qc.invalidateQueries({ queryKey: ["cod"] });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function CodRow({ job, canApprove, canDispute, onChanged }: { job: JobSummaryDto; canApprove: boolean; canDispute: boolean; onChanged: () => void }): React.JSX.Element {
  const [note, setNote] = useState("");
  const [showDispute, setShowDispute] = useState(false);
  const v = variance(job);
  const [disputeType, setDisputeType] = useState<CodDisputeType>(v != null && v < 0 ? "shortage" : v != null && v > 0 ? "overage" : "other");
  const approve = useMutation({
    mutationFn: () => apiFetch(API.cod.approve(job.id), { method: "POST", body: JSON.stringify({ note: note || undefined }) }),
    onSuccess: () => { setNote(""); onChanged(); },
  });
  const dispute = useMutation({
    mutationFn: () => apiFetch(API.cod.dispute(job.id), { method: "POST", body: JSON.stringify({ note, type: disputeType }) }),
    onSuccess: () => { setNote(""); setShowDispute(false); onChanged(); },
  });
  const archive = useMutation({
    mutationFn: () => apiFetch(API.cod.archive(job.id), { method: "POST" }),
    onSuccess: onChanged,
  });
  const unarchive = useMutation({
    mutationFn: () => apiFetch(API.cod.unarchive(job.id), { method: "POST" }),
    onSuccess: onChanged,
  });
  const actionable = job.codStatus === "collected" || job.codStatus === "handed_in" || job.codStatus === "disputed";
  const canAct = (canApprove || canDispute) && actionable;
  const canArchive = canDispute && job.codStatus === "approved";
  const error = approve.error ?? dispute.error ?? archive.error ?? unarchive.error;

  return (
    <section className={`card space-y-2 ${job.codArchivedAt ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{job.jobNumber ?? job.id.slice(0, 8)}</h2>
          <p className="text-xs text-zinc-400">{job.customerName} · {job.riderName ?? "Unassigned"}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {job.codDisputeType ? (
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300">{DISPUTE_TYPE_LABEL[job.codDisputeType]}</span>
          ) : null}
          {job.codArchivedAt ? <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-500">Archived</span> : null}
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[job.codStatus]}`}>{STATUS_LABEL[job.codStatus]}</span>
        </div>
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
              <div>
                <label className="label" htmlFor={`type-${job.id}`}>Type</label>
                <select id={`type-${job.id}`} className="input" value={disputeType} onChange={(e) => setDisputeType(e.target.value as CodDisputeType)}>
                  <option value="shortage">Shortage</option>
                  <option value="overage">Overage</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <button className="btn !px-3 !py-1 text-xs" disabled={dispute.isPending || note.trim() === ""} onClick={() => void dispute.mutate()}>
                {dispute.isPending ? "Saving…" : "Confirm dispute"}
              </button>
              <button className="btn !px-3 !py-1 text-xs" onClick={() => setShowDispute(false)}>Cancel</button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {canApprove ? (
                <button className="btn-accent !px-3 !py-1 text-xs" disabled={approve.isPending} onClick={() => void approve.mutate()}>
                  {approve.isPending ? "Saving…" : "Approve cash drop-off"}
                </button>
              ) : null}
              {canDispute ? <button className="btn !px-3 !py-1 text-xs" onClick={() => setShowDispute(true)}>Dispute</button> : null}
            </div>
          )}
        </div>
      ) : null}
      {canArchive ? (
        <div className="flex flex-wrap gap-2">
          {job.codArchivedAt ? (
            <button className="btn !px-3 !py-1 text-xs" disabled={unarchive.isPending} onClick={() => void unarchive.mutate()}>
              {unarchive.isPending ? "Saving…" : "Unarchive"}
            </button>
          ) : (
            <button className="btn !px-3 !py-1 text-xs" disabled={archive.isPending} onClick={() => void archive.mutate()}>
              {archive.isPending ? "Saving…" : "Archive"}
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

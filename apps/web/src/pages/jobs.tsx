import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JOB_SOURCES, JOB_STATUSES, RIDER_STAGE_LABELS, allowedTransitions } from "@ronmacrae/contracts";
import type { JobSource, JobStatus, JobSummaryDto, RiderDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { JobOffersPanel } from "../components/job-offers-panel.js";

const STATUS_BADGE: Record<JobStatus, string> = {
  new: "bg-zinc-800 text-zinc-300",
  assigned: "bg-sky-900/50 text-sky-300",
  accepted: "bg-sky-900/50 text-sky-300",
  picked_up: "bg-indigo-900/50 text-indigo-300",
  in_transit: "bg-indigo-900/50 text-indigo-300",
  delivering: "bg-violet-900/50 text-violet-300",
  delivered: "bg-emerald-900/50 text-emerald-300",
  no_answer: "bg-amber-900/50 text-amber-300",
  location_changed: "bg-amber-900/50 text-amber-300",
  failed: "bg-red-900/50 text-red-300",
  returned: "bg-violet-900/50 text-violet-300",
  cancelled: "bg-zinc-800 text-zinc-500",
};

/** Transition options minus the ones covered by the dedicated assign/unassign buttons. */
function moveOptions(status: JobStatus): JobStatus[] {
  return allowedTransitions(status).filter((to) => to !== "assigned" && to !== "new");
}

interface RowProps {
  job: JobSummaryDto;
  riders: RiderDto[];
  canWrite: boolean;
  busy: boolean;
  offersOpen: boolean;
  onAssign: (jobId: string, riderId: string) => void;
  onUnassign: (jobId: string) => void;
  onMove: (jobId: string, to: JobStatus) => void;
  onToggleOffers: (jobId: string) => void;
}

function JobRow({ job, riders, canWrite, busy, offersOpen, onAssign, onUnassign, onMove, onToggleOffers }: RowProps): React.JSX.Element {
  const [riderId, setRiderId] = useState(job.riderId ?? "");
  const [moveTo, setMoveTo] = useState<JobStatus | "">("");
  const assignable = job.status === "new" || job.status === "assigned";
  const unassignable = job.status === "assigned" || job.status === "accepted";
  const moves = moveOptions(job.status);

  return (
    <tr className="border-t border-zinc-800 align-top">
      <td className="py-2 pr-3">
        <div className="font-medium text-zinc-200">{job.jobNumber ?? job.id.slice(0, 8)}</div>
        <div className="text-xs text-zinc-500">
          {job.source} · {job.type}
        </div>
        {job.itemSummary ? (
          <div className="max-w-40 truncate text-xs text-zinc-500" title={job.itemSummary}>
            {job.itemSummary}
          </div>
        ) : null}
      </td>
      <td className="py-2 pr-3">
        <div className="text-zinc-200">{job.customerName}</div>
        <div className="text-xs text-zinc-500">{job.customerPhone}</div>
      </td>
      <td className="max-w-44 py-2 pr-3">
        <div className="truncate text-zinc-300" title={job.addressText ?? undefined}>
          {job.addressText ?? "–"}
        </div>
        {job.zoneName ? <div className="text-xs text-zinc-500">{job.zoneName}</div> : null}
      </td>
      <td className="py-2 pr-3">
        <span className={`whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[job.status]}`}>
          {job.status}
        </span>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-xs text-zinc-400">{RIDER_STAGE_LABELS[job.stage]}</td>
      <td className="whitespace-nowrap py-2 pr-3">
        <div>{formatMoney(job.amountExpected)}</div>
        <div className="text-xs text-zinc-500">{job.paymentStatus}</div>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-zinc-300">{job.riderName ?? "—"}</td>
      {canWrite ? (
        <td className="py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {assignable ? (
              <>
                <select
                  className="input w-40 !py-1"
                  value={riderId}
                  disabled={busy}
                  onChange={(e) => setRiderId(e.target.value)}
                >
                  <option value="">Rider…</option>
                  {riders.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} · {r.status}
                    </option>
                  ))}
                </select>
                <button
                  className="btn !px-3 !py-1 text-xs"
                  disabled={busy || riderId === ""}
                  onClick={() => onAssign(job.id, riderId)}
                >
                  {job.riderId ? "Reassign" : "Assign"}
                </button>
              </>
            ) : null}
            {unassignable ? (
              <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => onUnassign(job.id)}>
                Unassign
              </button>
            ) : null}
            {moves.length > 0 ? (
              <>
                <select
                  className="input w-36 !py-1"
                  value={moveTo}
                  disabled={busy}
                  onChange={(e) => setMoveTo(e.target.value as JobStatus | "")}
                >
                  <option value="">Move to…</option>
                  {moves.map((to) => (
                    <option key={to} value={to}>
                      {to}
                    </option>
                  ))}
                </select>
                <button
                  className="btn !px-3 !py-1 text-xs"
                  disabled={busy || moveTo === ""}
                  onClick={() => {
                    onMove(job.id, moveTo as JobStatus);
                    setMoveTo("");
                  }}
                >
                  Move
                </button>
              </>
            ) : null}
            {!assignable && !unassignable && moves.length === 0 ? (
              <span className="text-xs text-zinc-600">closed</span>
            ) : null}
            {job.status === "new" ? (
              <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => onToggleOffers(job.id)}>
                {offersOpen ? "Hide offers" : "Offers"}
              </button>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}

export function Jobs(): React.JSX.Element {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canWrite = user?.role === "admin" || user?.role === "dispatcher";
  const [offersJobId, setOffersJobId] = useState<string | null>(null);

  const [status, setStatus] = useState<JobStatus | "">("");
  const [source, setSource] = useState<JobSource | "">("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const jobs = useQuery({
    queryKey: ["jobs", status, source, search],
    queryFn: () => {
      const p = new URLSearchParams({ take: "100" });
      if (status) p.set("status", status);
      if (source) p.set("source", source);
      if (search) p.set("search", search);
      return apiFetch<{ jobs: JobSummaryDto[]; total: number }>(`/jobs?${p.toString()}`);
    },
    refetchInterval: 15_000,
  });

  const riders = useQuery({
    queryKey: ["riders"],
    queryFn: () => apiFetch<{ riders: RiderDto[] }>("/riders"),
    enabled: canWrite,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["jobs"] });
    void qc.invalidateQueries({ queryKey: ["riders"] });
  };

  const assign = useMutation({
    mutationFn: ({ jobId, riderId }: { jobId: string; riderId: string }) =>
      apiFetch(`/jobs/${jobId}/assignments`, { method: "POST", body: JSON.stringify({ riderId }) }),
    onSettled: invalidate,
  });
  const unassign = useMutation({
    mutationFn: (jobId: string) =>
      apiFetch(`/jobs/${jobId}/assignments`, { method: "DELETE", body: JSON.stringify({}) }),
    onSettled: invalidate,
  });
  const move = useMutation({
    mutationFn: ({ jobId, to }: { jobId: string; to: JobStatus }) =>
      apiFetch(`/jobs/${jobId}/transition`, { method: "POST", body: JSON.stringify({ to }) }),
    onSettled: invalidate,
  });

  const busy = assign.isPending || unassign.isPending || move.isPending;
  const error = assign.error ?? unassign.error ?? move.error;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Jobs</h1>
          <p className="text-sm text-zinc-400">Dispatch queue — assign riders, move jobs, keep track of cash</p>
        </div>
        {canWrite ? null : (
          <span className="rounded px-2 py-0.5 text-xs font-medium bg-zinc-800 text-zinc-400">read-only</span>
        )}
      </header>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="label" htmlFor="job-status">
              Status
            </label>
            <select
              id="job-status"
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as JobStatus | "")}
            >
              <option value="">All statuses</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="job-source">
              Source
            </label>
            <select
              id="job-source"
              className="input"
              value={source}
              onChange={(e) => setSource(e.target.value as JobSource | "")}
            >
              <option value="">All sources</option>
              {JOB_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="job-search">
              Search
            </label>
            <input
              id="job-search"
              className="input"
              placeholder="Job number, customer, phone or address"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        </div>
      </section>

      <section className="card">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Dispatch queue</h2>
          <span className="text-xs text-zinc-500">
            {jobs.data ? `${jobs.data.jobs.length} of ${jobs.data.total} jobs` : "loading…"}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-1 pr-3">Job</th>
                <th className="py-1 pr-3">Customer</th>
                <th className="py-1 pr-3">Location</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Stage</th>
                <th className="py-1 pr-3">Expected</th>
                <th className="py-1 pr-3">Rider</th>
                {canWrite ? <th className="py-1">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {jobs.data?.jobs.map((job) => (
                <React.Fragment key={job.id}>
                  <JobRow
                    job={job}
                    riders={riders.data?.riders ?? []}
                    canWrite={canWrite}
                    busy={busy}
                    offersOpen={offersJobId === job.id}
                    onAssign={(id, rid) => void assign.mutate({ jobId: id, riderId: rid })}
                    onUnassign={(id) => void unassign.mutate(id)}
                    onMove={(id, to) => void move.mutate({ jobId: id, to })}
                    onToggleOffers={(id) => setOffersJobId((cur) => (cur === id ? null : id))}
                  />
                  {offersJobId === job.id ? (
                    <tr className="border-t border-zinc-800" data-testid={`offers-panel-${job.id}`}>
                      <td colSpan={canWrite ? 8 : 7} className="py-2">
                        <JobOffersPanel jobId={job.id} jobStatus={job.status} canWrite={canWrite} />
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {jobs.isLoading ? (
          <p className="mt-2 text-sm text-zinc-500">Loading jobs…</p>
        ) : jobs.data && jobs.data.jobs.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No jobs match the filters.</p>
        ) : null}
        {error ? (
          <p className="mt-2 text-sm text-red-400">{error instanceof ApiError ? error.message : "Request failed"}</p>
        ) : null}
      </section>
    </div>
  );
}

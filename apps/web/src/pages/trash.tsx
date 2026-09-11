import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API, type TrashedJobDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Deleted-orders trash (spec 8, Stage 26) — soft-delete only, ever; nothing
 * shown here was actually removed from the database (see schema.prisma's
 * own note on Job.deletedAt). Restorable for 30 days from deletion.
 */
export function Trash(): React.JSX.Element {
  const { user } = useAuth();
  const canWrite = user?.role === "admin" || user?.role === "dispatcher";
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const trash = useQuery({
    queryKey: ["jobs-trash"],
    queryFn: () => apiFetch<{ jobs: TrashedJobDto[] }>(API.jobs.trash),
    refetchInterval: 30_000,
  });

  const restore = useMutation({
    mutationFn: (id: string) => apiFetch(API.jobs.restore(id), { method: "POST" }),
    onMutate: (id) => setBusyId(id),
    onSettled: () => setBusyId(null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["jobs-trash"] }),
  });

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold">Trash</h1>
        <p className="text-sm text-zinc-400">
          Deleted orders stay here for 30 days and can be restored — nothing is permanently removed, and cash-ledger,
          dispute and audit records are never affected either way.
        </p>
      </header>

      {trash.isLoading ? (
        <div className="card">
          <p className="text-sm text-zinc-400">Loading…</p>
        </div>
      ) : trash.error ? (
        <div className="card">
          <p className="text-sm text-red-300">{trash.error instanceof ApiError ? trash.error.message : "Couldn't load the trash."}</p>
          <button className="btn mt-2" onClick={() => void trash.refetch()}>
            Try again
          </button>
        </div>
      ) : (trash.data?.jobs.length ?? 0) === 0 ? (
        <div className="card">
          <p className="text-sm text-zinc-400">Nothing in the trash.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {trash.data!.jobs.map((job) => (
            <div key={job.id} className="card" data-testid={`trash-row-${job.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-zinc-200">{job.jobNumber ?? job.id.slice(0, 8)}</span>
                    <span className="text-sm text-zinc-300">{job.customerName}</span>
                    {job.purged ? (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                        Restore window closed
                      </span>
                    ) : (
                      <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                        {job.daysRemaining} day{job.daysRemaining === 1 ? "" : "s"} left
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500">{job.itemSummary ?? "—"}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Deleted {when(job.deletedAt)}
                    {job.deletedByName ? ` by ${job.deletedByName}` : ""}
                    {job.deleteReason ? ` — "${job.deleteReason}"` : ""}
                  </p>
                </div>
                {canWrite && !job.purged ? (
                  <button className="btn-accent !px-3 !py-1 text-xs" disabled={busyId === job.id} onClick={() => restore.mutate(job.id)}>
                    {busyId === job.id ? "Restoring…" : "Restore"}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API } from "@ronmacrae/contracts";
import type { JobOfferDto, JobStatus } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";
import { useRealtime } from "../lib/realtime.js";

const OFFER_BADGE: Record<JobOfferDto["status"], string> = {
  open: "bg-sky-900/50 text-sky-300",
  accepted: "bg-emerald-900/50 text-emerald-300",
  declined: "bg-amber-900/50 text-amber-300",
  withdrawn: "bg-zinc-800 text-zinc-500",
  expired: "bg-zinc-800 text-zinc-500",
};

/**
 * Dispatcher-facing broadcast/rebroadcast/withdraw controls plus the live offer list
 * for one job. Rendered as an expandable row under the Jobs table (see jobs.tsx).
 * Only `new`/unassigned jobs can be broadcast (server-enforced; mirrored here so the
 * button doesn't invite a 409).
 */
export function JobOffersPanel({ jobId, jobStatus, canWrite }: { jobId: string; jobStatus: JobStatus; canWrite: boolean }): React.JSX.Element {
  const qc = useQueryClient();
  const [expiresInMinutes, setExpiresInMinutes] = useState(15);
  const canBroadcast = canWrite && jobStatus === "new";

  const offers = useQuery({
    queryKey: ["job-offers", jobId],
    queryFn: () => apiFetch<{ offers: JobOfferDto[] }>(API.offers.list(jobId)),
    // Realtime (below) delivers new offers and the accept outcome immediately;
    // this interval is just the fallback for anything realtime misses (a dropped
    // connection, a decline/expiry, which aren't pushed yet).
    refetchInterval: 20_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["job-offers", jobId] });
    void qc.invalidateQueries({ queryKey: ["jobs"] });
  };

  const { subscribe, onReconnect } = useRealtime();
  useEffect(
    () =>
      subscribe(["offer", "job.assigned"], (msg) => {
        if (msg.type === "offer" && msg.payload.jobId === jobId) invalidate();
        else if (msg.type === "job.assigned" && msg.payload.job.id === jobId) invalidate();
      }),
    [subscribe, jobId],
  );
  // Catch up immediately on (re)connect rather than waiting out the poll interval.
  useEffect(() => onReconnect(invalidate), [onReconnect]);

  // Expiry is purely a function of `expiresAt` vs. the clock — reflect it the
  // instant it happens rather than waiting for the next poll to see the row the
  // server itself only lazily flips to `expired` on the next offer-related read.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const broadcast = useMutation({
    mutationFn: () => apiFetch(API.offers.broadcast(jobId), { method: "POST", body: JSON.stringify({ expiresInMinutes }) }),
    onSuccess: invalidate,
  });
  const rebroadcast = useMutation({
    mutationFn: () => apiFetch(API.offers.rebroadcast(jobId), { method: "POST", body: JSON.stringify({ expiresInMinutes }) }),
    onSuccess: invalidate,
  });
  const withdraw = useMutation({
    mutationFn: (offerId: string) => apiFetch(API.offers.withdraw(offerId), { method: "POST", body: JSON.stringify({}) }),
    onSuccess: invalidate,
  });

  const list = offers.data?.offers ?? [];
  // Expiry is a pure function of `expiresAt` vs. the clock — `now` (ticking every
  // second, above) forces this to recompute without waiting on a server round-trip.
  const effectiveStatus = (o: JobOfferDto): JobOfferDto["status"] =>
    o.status === "open" && new Date(o.expiresAt).getTime() <= now ? "expired" : o.status;
  const hasOpen = list.some((o) => effectiveStatus(o) === "open");
  const busy = broadcast.isPending || rebroadcast.isPending || withdraw.isPending;
  const error = broadcast.error ?? rebroadcast.error ?? withdraw.error;

  return (
    <div className="space-y-3 rounded-lg border border-zinc-700 bg-zinc-900/40 p-3">
      {canBroadcast ? (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor={`offer-expiry-${jobId}`}>
              Offer expires in (minutes)
            </label>
            <input
              id={`offer-expiry-${jobId}`}
              type="number"
              min={1}
              max={120}
              className="input w-24 !py-1"
              value={expiresInMinutes}
              onChange={(e) => setExpiresInMinutes(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
            />
          </div>
          <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => void broadcast.mutate()}>
            {list.length > 0 ? "Broadcast again" : "Broadcast to available couriers"}
          </button>
          {hasOpen ? (
            <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => void rebroadcast.mutate()}>
              Rebroadcast (withdraw + resend)
            </button>
          ) : null}
        </div>
      ) : !canWrite ? null : (
        <p className="text-xs text-zinc-500">Offers can only be sent while the job is unassigned.</p>
      )}
      {error ? (
        <p className="text-sm text-red-400">{error instanceof ApiError ? error.message : "Offer action failed"}</p>
      ) : null}
      {offers.isLoading ? <p className="text-sm text-zinc-500">Loading offers…</p> : null}
      {offers.data && list.length === 0 ? <p className="text-sm text-zinc-500">No offers sent yet.</p> : null}
      {list.length > 0 ? (
        <ul className="space-y-1">
          {list.map((o) => {
            const status = effectiveStatus(o);
            return (
            <li key={o.id} data-testid={`offer-rider-${o.riderId ?? o.id}`} className="flex flex-wrap items-center gap-2 rounded bg-zinc-900/60 px-2 py-1 text-sm">
              <span className="min-w-24 text-zinc-200">{o.riderName ?? "Courier"}</span>
              {o.urgent ? <span className="rounded bg-red-900/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-200">Urgent</span> : null}
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${OFFER_BADGE[status]}`}>{status}</span>
              <span className="text-xs text-zinc-500">
                {status === "open" ? "expires " : "expired "}
                {new Date(o.expiresAt).toLocaleTimeString("en-JM", { hour: "numeric", minute: "2-digit" })}
              </span>
              {canWrite && status === "open" ? (
                <button className="btn !px-2 !py-0.5 text-xs" disabled={busy} onClick={() => void withdraw.mutate(o.id)}>
                  Withdraw
                </button>
              ) : null}
            </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

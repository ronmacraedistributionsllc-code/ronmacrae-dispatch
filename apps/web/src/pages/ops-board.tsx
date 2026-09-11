import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OpsBoardDto, OpsBoardRiderDto } from "@ronmacrae/contracts";
import { API } from "@ronmacrae/contracts";
import { apiFetch, formatMoney } from "../lib/api.js";
import { ReadOnlyRiderQueue } from "../components/route-queue.js";

const STATUS_LABEL: Record<string, string> = { available: "Available", on_job: "Available", unavailable: "Unavailable", offline: "Offline" };
const STATUS_BADGE: Record<string, string> = {
  available: "bg-emerald-900/50 text-emerald-300",
  on_job: "bg-emerald-900/50 text-emerald-300",
  unavailable: "bg-zinc-800 text-zinc-400",
  offline: "bg-zinc-800 text-zinc-500",
};

function ageLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function durationLabel(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Dispatcher/owner operations board (spec 5C) — one screen combining rider
 * availability/capacity/connectivity/location with waiting offers, urgent
 * and overdue jobs, and COD awaiting handover. Everything here is read plus
 * links out to where the actual action already lives (assign/broadcast on
 * the Jobs screen, reorder on the rider's own dashboard) — this screen's job
 * is to show what needs attention, not to duplicate those controls.
 */
export function OpsBoard(): React.JSX.Element {
  const board = useQuery({
    queryKey: ["ops-board"],
    queryFn: () => apiFetch<OpsBoardDto>(API.opsBoard),
    refetchInterval: 15_000,
  });
  const [queueRiderId, setQueueRiderId] = useState<string | null>(null);

  if (board.isLoading) return <p className="text-sm text-zinc-400">Loading operations board…</p>;
  if (!board.data) {
    return (
      <div className="card space-y-2">
        <p className="text-sm text-red-400">Could not load the operations board.</p>
        <button className="btn !px-3 !py-1.5 text-sm" onClick={() => void board.refetch()}>Try again</button>
      </div>
    );
  }
  const data = board.data;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Operations board</h1>
        <p className="text-sm text-zinc-400">Updated {new Date(data.generatedAt).toLocaleTimeString("en-JM")} · refreshes every 15s</p>
      </header>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Riders</h2>
        {data.riders.length === 0 ? <p className="text-sm text-zinc-500">No active riders.</p> : null}

        {/* Desktop/tablet: dense table. A 6-column table is unusable on a
         *  phone (forces sideways scrolling, tiny tap targets), so mobile
         *  gets its own stacked-card layout below instead. */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-1 pr-3">Rider</th>
                <th className="py-1 pr-3">Availability</th>
                <th className="py-1 pr-3">Active / capacity</th>
                <th className="py-1 pr-3">Connection</th>
                <th className="py-1 pr-3">Last location</th>
                <th className="py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.riders.map((r) => (
                <RiderRow key={r.id} rider={r} queueOpen={queueRiderId === r.id} onToggleQueue={() => setQueueRiderId((cur) => (cur === r.id ? null : r.id))} />
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-2 md:hidden">
          {data.riders.map((r) => (
            <RiderCard key={r.id} rider={r} queueOpen={queueRiderId === r.id} onToggleQueue={() => setQueueRiderId((cur) => (cur === r.id ? null : r.id))} />
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Waiting offers ({data.waitingOffers.length})</h2>
          {data.waitingOffers.length === 0 ? <p className="text-sm text-zinc-500">None right now.</p> : null}
          <ul className="space-y-1 text-sm">
            {data.waitingOffers.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2 rounded bg-zinc-900/40 px-2 py-1">
                <span className="text-zinc-200">
                  {o.urgent ? <span className="mr-1 rounded bg-red-900/70 px-1 py-0.5 text-[10px] font-bold uppercase text-red-200">Urgent</span> : null}
                  {o.jobNumber ?? o.jobId.slice(0, 8)} → {o.riderName}
                </span>
                <span className="text-xs text-zinc-500">expires {new Date(o.expiresAt).toLocaleTimeString("en-JM", { hour: "numeric", minute: "2-digit" })}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Urgent jobs ({data.urgentJobs.length})</h2>
          {data.urgentJobs.length === 0 ? <p className="text-sm text-zinc-500">None right now.</p> : null}
          <ul className="space-y-1 text-sm">
            {data.urgentJobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2 rounded bg-red-950/20 px-2 py-1">
                <span className="text-zinc-200">{j.jobNumber ?? j.id.slice(0, 8)} · {j.riderName ?? "Unassigned"}</span>
                <a className="text-xs text-sky-400 hover:underline" href="/jobs">View in Jobs</a>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Overdue jobs ({data.overdueJobs.length})</h2>
          {data.overdueJobs.length === 0 ? <p className="text-sm text-zinc-500">None right now.</p> : null}
          <ul className="space-y-1 text-sm">
            {data.overdueJobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2 rounded bg-amber-950/20 px-2 py-1">
                <span className="text-zinc-200">{j.jobNumber ?? j.id.slice(0, 8)} · {j.riderName ?? "Unassigned"}</span>
                <span className="text-xs text-amber-300">{durationLabel(j.overdueByMs)} overdue</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">COD awaiting handover approval ({data.codAwaitingHandover.length})</h2>
          {data.codAwaitingHandover.length === 0 ? <p className="text-sm text-zinc-500">None right now.</p> : null}
          <ul className="space-y-1 text-sm">
            {data.codAwaitingHandover.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2 rounded bg-zinc-900/40 px-2 py-1">
                <span className="text-zinc-200">{j.jobNumber ?? j.id.slice(0, 8)} · {j.riderName ?? "Unassigned"}</span>
                <span className="text-xs text-zinc-400">{formatMoney(j.codHandedInAmount)} handed in</span>
              </li>
            ))}
          </ul>
          <a className="mt-2 inline-block text-xs text-sky-400 hover:underline" href="/cod">Open COD reconciliation</a>
        </section>
      </div>
    </div>
  );
}

function RiderRow({ rider, queueOpen, onToggleQueue }: { rider: OpsBoardRiderDto; queueOpen: boolean; onToggleQueue: () => void }): React.JSX.Element {
  const loc = rider.location;
  return (
    <>
      <tr className="border-t border-zinc-800" data-testid={`ops-rider-row-${rider.id}`}>
        <td className="py-2 pr-3 text-zinc-200">{rider.name}</td>
        <td className="py-2 pr-3">
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[rider.status] ?? "bg-zinc-800 text-zinc-400"}`}>
            {STATUS_LABEL[rider.status] ?? rider.status}
          </span>
        </td>
        <td className="py-2 pr-3 text-zinc-200">
          {rider.activeJobCount} / {rider.capacity}
          {rider.capacityRemaining === 0 ? <span className="ml-1 text-xs text-amber-400">(full)</span> : null}
        </td>
        <td className="py-2 pr-3">
          <span className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className={`h-2 w-2 rounded-full ${rider.connected ? "bg-emerald-500" : "bg-zinc-600"}`} />
            {rider.connected ? "Connected" : "Not connected"}
          </span>
        </td>
        <td className="py-2 pr-3">
          {loc ? (
            <span className={`text-xs ${loc.stale ? "text-amber-400" : "text-zinc-400"}`}>
              {ageLabel(loc.ageMs)}
              {loc.stale ? " — stale, may not be current" : ""}
            </span>
          ) : (
            <span className="text-xs text-zinc-600">No report yet</span>
          )}
        </td>
        <td className="py-2">
          <div className="flex flex-wrap gap-2">
            <a className="btn !px-2 !py-0.5 text-xs" href={`tel:${rider.phone}`}>Call</a>
            <a className="btn !px-2 !py-0.5 text-xs" href={`sms:${rider.phone}`}>Message</a>
            <button className="btn !px-2 !py-0.5 text-xs" onClick={onToggleQueue}>{queueOpen ? "Hide queue" : "Route queue"}</button>
          </div>
        </td>
      </tr>
      {queueOpen ? (
        <tr className="border-t border-zinc-800" data-testid={`ops-queue-${rider.id}`}>
          <td colSpan={6} className="py-2">
            <ReadOnlyRiderQueue riderId={rider.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Mobile equivalent of RiderRow — same data, stacked instead of columnar so
 *  it's readable and tappable at phone width without sideways scrolling. */
function RiderCard({ rider, queueOpen, onToggleQueue }: { rider: OpsBoardRiderDto; queueOpen: boolean; onToggleQueue: () => void }): React.JSX.Element {
  const loc = rider.location;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3" data-testid={`ops-rider-card-${rider.id}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-100">{rider.name}</span>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[rider.status] ?? "bg-zinc-800 text-zinc-400"}`}>
          {STATUS_LABEL[rider.status] ?? rider.status}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
        <div>
          <dt className="label !mb-0">Active / capacity</dt>
          <dd className="text-zinc-200">
            {rider.activeJobCount} / {rider.capacity}
            {rider.capacityRemaining === 0 ? <span className="ml-1 text-xs text-amber-400">(full)</span> : null}
          </dd>
        </div>
        <div>
          <dt className="label !mb-0">Connection</dt>
          <dd className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className={`h-2 w-2 rounded-full ${rider.connected ? "bg-emerald-500" : "bg-zinc-600"}`} />
            {rider.connected ? "Connected" : "Not connected"}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="label !mb-0">Last location</dt>
          <dd>
            {loc ? (
              <span className={`text-xs ${loc.stale ? "text-amber-400" : "text-zinc-400"}`}>
                {ageLabel(loc.ageMs)}
                {loc.stale ? " — stale, may not be current" : ""}
              </span>
            ) : (
              <span className="text-xs text-zinc-600">No report yet</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <a className="btn !px-3 !py-1.5 text-xs" href={`tel:${rider.phone}`}>📞 Call</a>
        <a className="btn !px-3 !py-1.5 text-xs" href={`sms:${rider.phone}`}>💬 Message</a>
        <button className="btn !px-3 !py-1.5 text-xs" onClick={onToggleQueue}>{queueOpen ? "Hide queue" : "Route queue"}</button>
      </div>
      {queueOpen ? (
        <div className="mt-3 border-t border-zinc-800 pt-3" data-testid={`ops-queue-card-${rider.id}`}>
          <ReadOnlyRiderQueue riderId={rider.id} />
        </div>
      ) : null}
    </div>
  );
}

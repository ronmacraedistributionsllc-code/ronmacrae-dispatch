import React from "react";
import type { JobStatus } from "@ronmacrae/contracts";
import type { Money } from "@ronmacrae/money";
import { formatMoney } from "../lib/api.js";

/** Statuses where the rider hasn't picked the package up yet — the queue's
 *  "next stop" for these is the pickup point; everything after is the
 *  destination. Mirrors the job lifecycle in state-machine.ts without
 *  importing rider-app-only stage details. */
const PRE_PICKUP_STATUSES = new Set(["assigned", "accepted"]);

export interface QueueStop {
  label: "Pickup" | "Destination";
  address: string | null;
  point: { lat: number; lng: number } | null;
}

/** The subset of JobDto/JobSummaryDto fields this component needs — satisfied
 *  structurally by both, so the rider's own dashboard (full JobDto) and a
 *  dispatcher's read-only view of another rider's queue (JobSummaryDto, from
 *  the list endpoint) can share this one component. */
export interface RouteQueueJob {
  id: string;
  jobNumber: string | null;
  status: JobStatus;
  priority: string;
  itemSummary: string | null;
  amountExpected: Money | null;
  scheduledAt: string | null;
  routeSeq: number | null;
  addressText: string | null;
  point: { lat: number; lng: number } | null;
  pickupAddressText: string | null;
  pickupPoint: { lat: number; lng: number } | null;
  createdAt: string;
}

/** Which stop is next for this job right now, given its current status. Only
 *  ever describes what's already known (address/point already on the job) —
 *  never a distance or ETA figure, which belongs to a real routing provider,
 *  not a straight-line guess. */
export function nextStopFor(job: RouteQueueJob): QueueStop {
  // "assigned"/"accepted" (even once at the pickup, mid-collection) still
  // means the package hasn't been collected yet — status only becomes
  // "picked_up" once it has, which is the real signal to switch stops.
  if (PRE_PICKUP_STATUSES.has(job.status)) return { label: "Pickup", address: job.pickupAddressText, point: job.pickupPoint };
  return { label: "Destination", address: job.addressText, point: job.point };
}

/** A universal "get directions" link: opens the device's own default map/nav
 *  app on mobile (Google Maps app, Apple Maps via Safari's interception, or
 *  the Google Maps site elsewhere) — never our own in-app map, and never a
 *  distance/ETA claim, just a handoff to real navigation. */
export function mapsUrlFor(point: { lat: number; lng: number } | null, address: string | null): string | null {
  if (point) return `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}`;
  if (address) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  return null;
}

interface RouteQueueProps {
  /** Active jobs only, already filtered by the caller — this component just
   *  orders and renders them. */
  jobs: RouteQueueJob[];
  /** When set, shows up/down reorder controls and calls back with the full
   *  reordered id list (the caller posts it — nothing here auto-saves or
   *  auto-rearranges on its own; every move is one explicit tap). */
  onReorder?: (orderedJobIds: string[]) => void;
  reordering?: boolean;
}

/**
 * Compact, mobile-friendly ordered list of a rider's active jobs — the
 * "route queue" (spec 5B). Distinct from the full per-job detail cards
 * elsewhere on the dashboard: this is deliberately compact (one row per
 * stop) so it's usable at a glance on a phone between deliveries.
 */
export function RouteQueue({ jobs, onReorder, reordering }: RouteQueueProps): React.JSX.Element {
  // routeSeq is only set once the rider has explicitly reordered at least
  // once; until then, fall back to requested date, and finally to which job
  // was accepted/assigned first (oldest first — first-in-first-out), so the
  // list has a sensible, deterministic order from the start rather than
  // depending on whatever order the API happened to return them in.
  const ordered = [...jobs].sort((a, b) => {
    if (a.routeSeq != null && b.routeSeq != null) return a.routeSeq - b.routeSeq;
    if (a.routeSeq != null) return -1;
    if (b.routeSeq != null) return 1;
    const at = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Infinity;
    const bt = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Infinity;
    if (at !== bt) return at - bt;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  function move(index: number, dir: -1 | 1): void {
    if (!onReorder) return;
    const next = [...ordered];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onReorder(next.map((j) => j.id));
  }

  if (ordered.length === 0) return <p className="text-sm text-zinc-500">No active stops.</p>;

  return (
    <ol className="space-y-2">
      {ordered.map((job, i) => {
        const stop = nextStopFor(job);
        const mapsUrl = mapsUrlFor(stop.point, stop.address);
        const urgent = job.priority === "urgent";
        return (
          <li key={job.id} className={`flex items-start gap-2 rounded-lg border p-2 ${urgent ? "border-red-800/60 bg-red-950/10" : "border-zinc-700 bg-zinc-900/40"}`}>
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-300">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {urgent ? <span className="rounded bg-red-900/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-200">Urgent</span> : null}
                <span className="text-sm font-medium text-zinc-200">{job.jobNumber ?? job.id.slice(0, 8)}</span>
                <span className="text-xs text-zinc-500">· {stop.label}</span>
              </div>
              <p className="truncate text-xs text-zinc-400">{stop.address ?? "Address not supplied"}</p>
              <p className="text-xs text-zinc-500">
                {job.itemSummary ?? "No item details"}
                {job.amountExpected ? ` · COD ${formatMoney(job.amountExpected)}` : ""}
                {job.scheduledAt ? ` · requested ${new Date(job.scheduledAt).toLocaleDateString("en-JM", { month: "short", day: "numeric" })}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {mapsUrl ? (
                <a className="btn !px-2 !py-0.5 text-xs" href={mapsUrl} target="_blank" rel="noreferrer">
                  Open in Maps
                </a>
              ) : null}
              {onReorder ? (
                <div className="flex gap-1">
                  <button type="button" className="btn !px-1.5 !py-0.5 text-xs" disabled={reordering || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    ↑
                  </button>
                  <button type="button" className="btn !px-1.5 !py-0.5 text-xs" disabled={reordering || i === ordered.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    ↓
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

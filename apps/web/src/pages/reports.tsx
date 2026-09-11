import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OperatingReportDto, RiderDto, ZoneDto } from "@ronmacrae/contracts";
import { API } from "@ronmacrae/contracts";
import { apiFetch, formatMoney } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

interface Filters {
  from: string;
  to: string;
  riderId: string;
  zoneId: string;
  bucket: "" | "completed" | "active" | "failed_cancelled";
  paymentMethod: string;
}

const EMPTY_FILTERS: Filters = { from: "", to: "", riderId: "", zoneId: "", bucket: "", paymentMethod: "" };

function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.riderId) p.set("riderId", f.riderId);
  if (f.zoneId) p.set("zoneId", f.zoneId);
  if (f.bucket) p.set("bucket", f.bucket);
  if (f.paymentMethod) p.set("paymentMethod", f.paymentMethod);
  return p.toString();
}

function minutesLabel(ms: number | null): string {
  if (ms == null) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Owner/accountant operating reports (spec 5E). Filterable summary +
 * per-rider breakdown + a CSV export of the underlying job rows. Every
 * money/time figure that could be incomplete (off-currency jobs, riders with
 * no pay rate, too few completed jobs for a stable average) is called out in
 * `notes` rather than silently folded into a total.
 */
export function Reports(): React.JSX.Element {
  const { user } = useAuth();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const query = toQuery(filters);
  const canView = user?.role === "admin" || user?.role === "accountant";

  const riders = useQuery({ queryKey: ["riders"], queryFn: () => apiFetch<{ riders: RiderDto[] }>(API.riders.list), enabled: canView });
  const zones = useQuery({ queryKey: ["zones"], queryFn: () => apiFetch<{ zones: ZoneDto[] }>(API.zones.list), enabled: canView });
  const report = useQuery({
    queryKey: ["operating-report", query],
    queryFn: () => apiFetch<OperatingReportDto>(`${API.reports.summary}${query ? `?${query}` : ""}`),
    enabled: canView,
  });

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  if (!canView) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">Operating reports</h1>
        <div className="card">
          <p className="text-sm text-zinc-400">Only an owner/admin or accountant can view operating reports.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Operating reports</h1>
          <p className="text-sm text-zinc-400">Deliveries, COD reconciliation, and rider performance for a date range.</p>
        </div>
        <a className="btn" href={`${API.reports.csv}${query ? `?${query}` : ""}`} target="_blank" rel="noreferrer">
          Export CSV
        </a>
      </header>

      <section className="card">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className="label" htmlFor="rp-from">From</label>
            <input id="rp-from" type="date" className="input" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="rp-to">To</label>
            <input id="rp-to" type="date" className="input" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="rp-rider">Rider</label>
            <select id="rp-rider" className="input" value={filters.riderId} onChange={(e) => set({ riderId: e.target.value })}>
              <option value="">All riders</option>
              {riders.data?.riders.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rp-zone">Zone</label>
            <select id="rp-zone" className="input" value={filters.zoneId} onChange={(e) => set({ zoneId: e.target.value })}>
              <option value="">All zones</option>
              {zones.data?.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rp-bucket">Status</label>
            <select id="rp-bucket" className="input" value={filters.bucket} onChange={(e) => set({ bucket: e.target.value as Filters["bucket"] })}>
              <option value="">All</option>
              <option value="completed">Completed</option>
              <option value="active">Active</option>
              <option value="failed_cancelled">Failed / cancelled</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rp-payment">Payment method</label>
            <select id="rp-payment" className="input" value={filters.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value })}>
              <option value="">All</option>
              <option value="cod">Cash on delivery</option>
              <option value="online">Paid online</option>
              <option value="card">Card</option>
              <option value="transfer">Transfer</option>
            </select>
          </div>
        </div>
        {(filters.from || filters.to || filters.riderId || filters.zoneId || filters.bucket || filters.paymentMethod) ? (
          <button className="btn mt-3 !px-3 !py-1 text-xs" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>
        ) : null}
      </section>

      {report.isLoading ? <p className="text-sm text-zinc-400">Loading…</p> : null}
      {report.data ? (
        <>
          {report.data.notes.length > 0 ? (
            <section className="card border-amber-800/50 bg-amber-950/10 space-y-1">
              {report.data.notes.map((n, i) => <p key={i} className="text-sm text-amber-200">⚠ {n}</p>)}
            </section>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard label="Completed" value={String(report.data.summary.deliveriesCompleted)} />
            <SummaryCard label="Active" value={String(report.data.summary.deliveriesActive)} />
            <SummaryCard label="Failed / cancelled" value={String(report.data.summary.deliveriesFailedCancelled)} />
            <SummaryCard label="Urgent deliveries" value={String(report.data.summary.urgentDeliveryCount)} />
            <SummaryCard label="Delivery fees charged" value={formatMoney(report.data.summary.deliveryFeesCharged)} />
            <SummaryCard
              label="Avg. delivery time"
              value={minutesLabel(report.data.summary.averageDeliveryTimeMs)}
              hint={`based on ${report.data.summary.averageDeliveryTimeSampleSize} completed deliver${report.data.summary.averageDeliveryTimeSampleSize === 1 ? "y" : "ies"}`}
            />
            <SummaryCard label="COD expected" value={formatMoney(report.data.summary.codExpected)} />
            <SummaryCard label="COD collected" value={formatMoney(report.data.summary.codCollected)} />
            <SummaryCard label="COD handed in" value={formatMoney(report.data.summary.codHandedIn)} />
            <SummaryCard label="COD outstanding" value={formatMoney(report.data.summary.codOutstanding)} tone={report.data.summary.codOutstanding.amount > 0 ? "warn" : undefined} />
            <SummaryCard label="COD shortage" value={formatMoney(report.data.summary.codShortageTotal)} tone={report.data.summary.codShortageTotal.amount > 0 ? "bad" : undefined} />
            <SummaryCard label="COD overage" value={formatMoney(report.data.summary.codOverageTotal)} tone={report.data.summary.codOverageTotal.amount > 0 ? "warn" : undefined} />
          </section>

          <section className="card overflow-x-auto">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">By rider</h2>
            {report.data.byRider.length === 0 ? (
              <p className="text-sm text-zinc-500">No completed deliveries in this range.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-zinc-500">
                    <th className="py-1 pr-4">Rider</th>
                    <th className="py-1 pr-4">Jobs completed</th>
                    <th className="py-1">Estimated earnings</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.byRider.map((r) => (
                    <tr key={r.riderId} className="border-t border-zinc-800">
                      <td className="py-2 pr-4 text-zinc-200">{r.riderName}</td>
                      <td className="py-2 pr-4 text-zinc-200">{r.jobsCompleted}</td>
                      <td className="py-2 text-zinc-200">{r.estimatedEarnings ? formatMoney(r.estimatedEarnings) : <span className="text-zinc-500">rate not set</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p className="text-xs text-zinc-600">
            {report.data.rows.length} matching job{report.data.rows.length === 1 ? "" : "s"} — export the CSV above for the
            full row-level detail (no delivery PINs or phone numbers included).
          </p>
        </>
      ) : null}
    </div>
  );
}

function SummaryCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" | "bad" }): React.JSX.Element {
  return (
    <div className={`card ${tone === "bad" ? "border-red-800/60 bg-red-950/10" : tone === "warn" ? "border-amber-800/50 bg-amber-950/10" : ""}`}>
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="text-lg font-semibold text-zinc-100">{value}</p>
      {hint ? <p className="text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

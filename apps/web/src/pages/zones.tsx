import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch, formatMoney } from "../lib/api.js";
import type { FareQuoteDto, GeoPoint, ZoneDto } from "@ronmacrae/contracts";

interface FareRule {
  id: string;
  fromZoneName: string;
  toZoneName: string;
  fee: { amount: number; currency: string };
  minFee: { amount: number; currency: string } | null;
  note: string | null;
}

/** average of all ring vertices — good enough as a quote origin/destination */
function centroid(zone: ZoneDto): GeoPoint {
  const polygons: [number, number][][][] =
    zone.geometry.type === "Polygon" ? [zone.geometry.coordinates] : zone.geometry.coordinates;
  let lat = 0;
  let lng = 0;
  let n = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        lng += x;
        lat += y;
        n++;
      }
    }
  }
  return n > 0 ? { lat: lat / n, lng: lng / n } : { lat: 17.9714, lng: -76.7932 };
}

export function Zones(): React.JSX.Element {
  const zones = useQuery({ queryKey: ["zones"], queryFn: () => apiFetch<{ zones: ZoneDto[] }>("/zones") });
  const rules = useQuery({
    queryKey: ["fare-rules"],
    queryFn: () => apiFetch<{ rules: FareRule[] }>("/zones/fare-rules"),
  });

  const [fromId, setFromId] = useState<string>("");
  const [toId, setToId] = useState<string>("");
  const [express, setExpress] = useState(false);
  const [heavy, setHeavy] = useState(false);
  const [quote, setQuote] = useState<FareQuoteDto | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = useMemo(() => zones.data?.zones.find((z) => z.id === fromId) ?? null, [zones.data, fromId]);
  const to = useMemo(() => zones.data?.zones.find((z) => z.id === toId) ?? null, [zones.data, toId]);

  async function onQuote() {
    if (!from || !to) return;
    setQuoting(true);
    setError(null);
    try {
      const q = await apiFetch<FareQuoteDto>("/quotes", {
        method: "POST",
        body: JSON.stringify({
          fromPoint: centroid(from),
          toPoint: centroid(to),
          fromZoneId: from.id,
          toZoneId: to.id,
          express,
          heavy,
        }),
      });
      setQuote(q);
    } catch (err) {
      setQuote(null);
      setError(err instanceof ApiError ? err.message : "Quote failed");
    } finally {
      setQuoting(false);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Zones &amp; Fares</h1>
        <p className="text-sm text-zinc-400">Delivery areas, base fees and a quick fare quote</p>
      </header>

      <section className="card">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="from">From</label>
            <select id="from" className="input" value={fromId} onChange={(e) => setFromId(e.target.value)}>
              <option value="">Select origin zone…</option>
              {zones.data?.zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="to">To</label>
            <select id="to" className="input" value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">Select destination zone…</option>
              {zones.data?.zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-6 md:col-span-2">
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={express} onChange={(e) => setExpress(e.target.checked)} />
              Express (+25%)
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={heavy} onChange={(e) => setHeavy(e.target.checked)} />
              Heavy item (+20%)
            </label>
            <button className="btn ml-auto" disabled={!from || !to || quoting} onClick={() => void onQuote()}>
              {quoting ? "Quoting…" : "Quote fee"}
            </button>
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
        {quote ? (
          <div className="mt-4 rounded-lg border border-brand/50 bg-brand/10 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-zinc-400">
                {from?.name} → {to?.name} · {quote.routingProvider} routing
              </span>
              <span className="text-2xl font-bold text-brand-accent">{formatMoney(quote.fee)}</span>
            </div>
            {quote.distanceM != null && quote.durationS != null ? (
              <div className="mt-1 text-xs text-zinc-400">
                ≈ {(quote.distanceM / 1000).toFixed(1)} km · {Math.round(quote.durationS / 60)} min
              </div>
            ) : null}
            <ul className="mt-3 space-y-1 text-sm text-zinc-300">
              {quote.breakdown.map((b) => (
                <li key={b.label} className="flex justify-between">
                  <span>{b.label}</span>
                  <span>{formatMoney(b.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Zones</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-zinc-500">
              <th className="py-1 pr-4">Zone</th>
              <th className="py-1 pr-4">Parish</th>
              <th className="py-1 pr-4">Base fee</th>
              <th className="py-1 pr-4">Per km</th>
              <th className="py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {zones.data?.zones.map((z) => (
              <tr key={z.id} className="border-t border-zinc-800">
                <td className="py-2 pr-4 font-medium text-zinc-200">{z.name}</td>
                <td className="py-2 pr-4 text-zinc-400">{z.parish ?? "–"}</td>
                <td className="py-2 pr-4">{formatMoney(z.baseFee)}</td>
                <td className="py-2 pr-4">{formatMoney(z.perKmFee)}</td>
                <td className="py-2">{z.active ? "active" : "disabled"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Zone-pair fare rules</h2>
        {rules.data && rules.data.rules.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-1 pr-4">Route</th>
                <th className="py-1 pr-4">Fee</th>
                <th className="py-1 pr-4">Min</th>
                <th className="py-1">Note</th>
              </tr>
            </thead>
            <tbody>
              {rules.data.rules.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800">
                  <td className="py-2 pr-4">{r.fromZoneName} → {r.toZoneName}</td>
                  <td className="py-2 pr-4">{formatMoney(r.fee)}</td>
                  <td className="py-2 pr-4">{formatMoney(r.minFee)}</td>
                  <td className="py-2 text-zinc-400">{r.note ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-zinc-500">No explicit zone-pair rules — quotes fall back to zone base + distance.</p>
        )}
      </section>
    </div>
  );
}

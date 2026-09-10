import React, { Suspense, useEffect, useRef, useState } from "react";
import { API } from "@ronmacrae/contracts";
import type { GeoSuggestionDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";

const PinMap = React.lazy(() => import("./pin-map.js").then((m) => ({ default: m.PinMap })));

export interface ConfirmedLocation {
  address: string;
  point: { lat: number; lng: number };
}

interface AddressPickerProps {
  title: string;
  value: ConfirmedLocation | null;
  onChange: (loc: ConfirmedLocation) => void;
  /** A point to bias/center search results around (e.g. the pickup, when picking the destination). */
  bias?: { lat: number; lng: number };
  required?: boolean;
}

/**
 * Address-first location picker: search → suggestions → map with a movable pin →
 * explicit "Confirm location" before the caller's `value` updates. Modeled on a
 * Starlink-signup-style address confirmation step.
 *
 * Handles both documented failure modes explicitly rather than silently:
 *  - Address search unreachable (network down, no provider configured): the API
 *    still returns a best-effort offline point (see CompositeGeoProvider's
 *    simulated fallback) flagged `degraded: true` — shown as a clear banner, and
 *    the map/pin still work so the order isn't blocked.
 *  - Map/tiles failing to load: caught via the lazy import + an error boundary-ish
 *    try/catch on the tile image; falls back to a coordinates-only confirmation
 *    (no visual map, but the flow still completes).
 */
export function AddressPicker({ title, value, onChange, bias, required }: AddressPickerProps): React.JSX.Element {
  const [editing, setEditing] = useState(!value);
  const [query, setQuery] = useState(value?.address ?? "");
  const [suggestions, setSuggestions] = useState<GeoSuggestionDto[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [mapError, setMapError] = useState(false);
  const [pending, setPending] = useState<ConfirmedLocation | null>(value);
  const reverseSeq = useRef(0);

  useEffect(() => {
    if (!editing) return;
    const q = query.trim();
    if (q.length < 3) {
      setSuggestions([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      apiFetch<{ results: GeoSuggestionDto[]; degraded: boolean }>(API.geo.geocode, {
        method: "POST",
        body: JSON.stringify({ query: q, limit: 5, ...(bias ? { bias } : {}) }),
      })
        .then((r) => {
          setSuggestions(r.results);
          setDegraded(r.degraded);
          setSearchError(null);
        })
        .catch((err) => {
          setSuggestions([]);
          setSearchError(err instanceof ApiError ? err.message : "Address search is unavailable right now — you can still drop a pin manually below.");
        })
        .finally(() => setSearching(false));
    }, 400);
    return () => clearTimeout(t);
  }, [query, editing, bias?.lat, bias?.lng]);

  function pickSuggestion(s: GeoSuggestionDto): void {
    setPending({ point: s.point, address: s.label });
    setQuery(s.label);
    setSuggestions([]);
  }

  function movePin(point: { lat: number; lng: number }): void {
    setPending((cur) => (cur ? { ...cur, point } : { point, address: query.trim() || "Dropped pin" }));
    const seq = ++reverseSeq.current;
    void apiFetch<{ label: string | null }>(API.geo.reverse, { method: "POST", body: JSON.stringify({ point }) })
      .then((r) => {
        if (seq !== reverseSeq.current || !r.label) return;
        setPending((cur) => (cur ? { ...cur, address: r.label! } : cur));
        setQuery(r.label!);
      })
      .catch(() => {
        // reverse geocoding is a label-quality nicety; the point itself is already set
      });
  }

  function confirm(): void {
    if (!pending) return;
    onChange(pending);
    setEditing(false);
  }

  if (!editing && value) {
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-900/40 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="label !mb-1">{title}</div>
            <p className="text-sm text-zinc-200">{value.address}</p>
            <p className="text-xs text-zinc-500">
              {value.point.lat.toFixed(5)}, {value.point.lng.toFixed(5)}
            </p>
          </div>
          <button type="button" className="btn !px-3 !py-1 text-xs" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-zinc-700 bg-zinc-900/40 p-3">
      <div className="label !mb-1">
        {title}
        {required ? <span className="text-red-400"> *</span> : null}
      </div>
      <input
        className="input"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPending(null);
        }}
        placeholder="Start typing an address…"
        autoComplete="off"
      />
      {searching ? <p className="text-xs text-zinc-500">Searching…</p> : null}
      {searchError ? <p className="text-xs text-amber-400">{searchError}</p> : null}
      {degraded ? (
        <p className="rounded bg-amber-900/30 px-2 py-1 text-xs text-amber-300">
          Address search is running in offline/approximate mode right now — the suggested pin may not be exact. Drag it
          to the correct spot before confirming.
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {suggestions.map((s, i) => (
            <li key={`${s.point.lat},${s.point.lng},${i}`}>
              <button type="button" className="w-full px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800" onClick={() => pickSuggestion(s)}>
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {pending ? (
        <div className="space-y-2">
          {mapError ? (
            <p className="text-sm text-zinc-400">
              Map preview unavailable — using the coordinates from your search ({pending.point.lat.toFixed(5)}, {pending.point.lng.toFixed(5)}).
            </p>
          ) : (
            <Suspense fallback={<p className="text-sm text-zinc-500">Loading map…</p>}>
              <MapErrorBoundary onError={() => setMapError(true)}>
                <PinMap lat={pending.point.lat} lng={pending.point.lng} onMove={movePin} />
              </MapErrorBoundary>
            </Suspense>
          )}
          <p className="text-xs text-zinc-500">Drag the pin, or click the map, to fine-tune the exact spot.</p>
          <button type="button" className="btn-accent" onClick={confirm}>
            Confirm location
          </button>
        </div>
      ) : !searching && suggestions.length === 0 && query.trim().length >= 3 && !searchError ? (
        <p className="text-sm text-zinc-500">No matches. Try a more specific address, or a nearby landmark.</p>
      ) : null}
    </div>
  );
}

/** Minimal class-component error boundary — React has no hook for this. */
class MapErrorBoundary extends React.Component<{ onError: () => void; children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(): void {
    this.props.onError();
  }
  override render(): React.ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

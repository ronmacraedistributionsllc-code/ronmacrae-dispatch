import React, { Suspense, useEffect, useRef, useState } from "react";
import { API } from "@ronmacrae/contracts";
import type { GeoSuggestionDto } from "@ronmacrae/contracts";
import { ApiError, apiFetch } from "../lib/api.js";

const PinMap = React.lazy(() => import("./pin-map.js").then((m) => ({ default: m.PinMap })));

/** Roughly the center of Jamaica — a last-resort pin position when even the
 *  backend's deterministic offline fallback can't be reached at all (network down
 *  AND the request itself throws). The user can still drag it into place. */
const ISLAND_FALLBACK_POINT = { lat: 18.05, lng: -77.3 };

export interface ConfirmedLocation {
  /** Exactly what the user typed. Always authoritative — never overwritten by
   *  geocoding, a picked suggestion, or a moved pin. This is what gets saved and
   *  shown as the delivery/pickup address everywhere in the app. */
  address: string;
  /** The geocoder's formatted match for this location, if one was found.
   *  Informational only — shown for transparency, never fed back into `address`. */
  providerAddress: string | null;
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
 * Address-first location picker: the user's typed text is always what gets
 * saved — suggestions and the map pin only ever help pick a *point*, they never
 * silently replace what was typed. Modeled on a Starlink-signup-style address
 * confirmation step, but "confirm" here means "confirm the pin position for the
 * address I typed", not "accept the provider's rewrite of my address".
 *
 * Handles both documented failure modes explicitly rather than silently:
 *  - Address search unreachable / provider can't find it: "Use this address"
 *    still works — it falls back to the backend's deterministic offline point
 *    (flagged `degraded: true`, shown as a banner) or, failing even that, a
 *    fixed island-center point — either way the user can drag the pin into place
 *    and finish, typed text untouched.
 *  - Map/tiles failing to load: caught via a small error boundary; falls back to
 *    a coordinates-only confirmation (no visual map, but the flow still completes).
 */
export function AddressPicker({ title, value, onChange, bias, required }: AddressPickerProps): React.JSX.Element {
  const [editing, setEditing] = useState(!value);
  const [query, setQuery] = useState(value?.address ?? "");
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(value?.point ?? null);
  const [providerAddress, setProviderAddress] = useState<string | null>(value?.providerAddress ?? null);
  const [suggestions, setSuggestions] = useState<GeoSuggestionDto[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [mapError, setMapError] = useState(false);
  const reverseSeq = useRef(0);
  const geocodeSeq = useRef(0);

  // Suggestions are just a convenience list to find a point quickly — selecting
  // one never touches the typed text below (see pickSuggestion).
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
          setSearchError(null);
        })
        .catch((err) => {
          setSuggestions([]);
          setSearchError(err instanceof ApiError ? err.message : "Address search is unavailable right now — you can still use the address you typed below.");
        })
        .finally(() => setSearching(false));
    }, 400);
    return () => clearTimeout(t);
  }, [query, editing, bias?.lat, bias?.lng]);

  /** Picking a suggestion only sets the pin + the informational provider match —
   *  it fills the typed field ONLY if the user hadn't typed anything of their own
   *  yet (a convenience for the empty-input case), and never touches it once
   *  there's user-authored text in it. */
  function pickSuggestion(s: GeoSuggestionDto): void {
    setPoint(s.point);
    setProviderAddress(s.label);
    setDegraded(s.provider === "simulated");
    setQuery((cur) => (cur.trim() === "" ? s.label : cur));
    setSuggestions([]);
  }

  /** The explicit "use exactly what I typed" action — resolves *a* point for the
   *  map (from a suggestion already picked, a fresh geocode, or a last-resort
   *  fallback) without ever changing the typed text itself. */
  async function useThisAddress(): Promise<void> {
    const typed = query.trim();
    if (!typed) return;
    if (point) return; // a suggestion (or a prior pin drop) already resolved one
    setResolving(true);
    setSearchError(null);
    const seq = ++geocodeSeq.current;
    try {
      const r = await apiFetch<{ results: GeoSuggestionDto[]; degraded: boolean }>(API.geo.geocode, {
        method: "POST",
        body: JSON.stringify({ query: typed, limit: 1, ...(bias ? { bias } : {}) }),
      });
      if (seq !== geocodeSeq.current) return;
      const first = r.results[0];
      if (first) {
        setPoint(first.point);
        setProviderAddress(first.label);
        setDegraded(r.degraded);
      } else {
        // The backend's own fallback chain always returns something for a
        // non-blank query — reaching here means something upstream is broken,
        // not just "address not found". Fall back to a plain pin the user
        // positions manually, and say so plainly rather than pretending.
        setPoint(bias ?? ISLAND_FALLBACK_POINT);
        setProviderAddress(null);
        setDegraded(true);
      }
    } catch (err) {
      if (seq !== geocodeSeq.current) return;
      setPoint(bias ?? ISLAND_FALLBACK_POINT);
      setProviderAddress(null);
      setSearchError(err instanceof ApiError ? err.message : "Could not verify this address automatically — position the pin manually below.");
    } finally {
      if (seq === geocodeSeq.current) setResolving(false);
    }
  }

  /** Moving the pin updates ONLY the point + the informational provider label —
   *  the typed address is never touched by this, per the no-silent-overwrite rule. */
  function movePin(next: { lat: number; lng: number }): void {
    setPoint(next);
    const seq = ++reverseSeq.current;
    void apiFetch<{ label: string | null }>(API.geo.reverse, { method: "POST", body: JSON.stringify({ point: next }) })
      .then((r) => {
        if (seq !== reverseSeq.current) return;
        setProviderAddress(r.label ?? null);
      })
      .catch(() => {
        // reverse geocoding is a transparency nicety; the point itself is already set
      });
  }

  function confirm(): void {
    const address = query.trim();
    if (!address || !point) return;
    onChange({ address, providerAddress, point });
    setEditing(false);
  }

  if (!editing && value) {
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-900/40 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="label !mb-1">{title}</div>
            <p className="text-sm text-zinc-200">{value.address}</p>
            {value.providerAddress && value.providerAddress !== value.address ? (
              <p className="text-xs text-zinc-500">Provider match: {value.providerAddress}</p>
            ) : null}
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
          setPoint(null);
          setProviderAddress(null);
        }}
        placeholder="Type the exact delivery address…"
        autoComplete="off"
      />
      <p className="text-xs text-zinc-500">
        This exact text is what gets saved as the address — suggestions below only help place the pin.
      </p>
      {searching ? <p className="text-xs text-zinc-500">Searching…</p> : null}
      {searchError ? <p className="text-xs text-amber-400">{searchError}</p> : null}
      {degraded ? (
        <p className="rounded bg-amber-900/30 px-2 py-1 text-xs text-amber-300">
          Could not verify this location automatically — the pin may not be exact. Drag it to the correct spot before
          confirming. Your typed address is kept exactly as entered either way.
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

      {!point && query.trim().length > 0 ? (
        <button type="button" className="btn" disabled={resolving} onClick={() => void useThisAddress()}>
          {resolving ? "Placing pin…" : "Use this address"}
        </button>
      ) : null}
      {!point && !searching && suggestions.length === 0 && query.trim().length >= 3 && !searchError ? (
        <p className="text-sm text-zinc-500">
          No suggestions matched. That's fine — click "Use this address" above to place a pin you can drag into position.
        </p>
      ) : null}

      {point ? (
        <div className="space-y-2">
          {providerAddress && providerAddress !== query.trim() ? (
            <p className="text-xs text-zinc-500">Provider match: {providerAddress}</p>
          ) : null}
          {mapError ? (
            <p className="text-sm text-zinc-400">
              Map preview unavailable — using the coordinates from your search ({point.lat.toFixed(5)}, {point.lng.toFixed(5)}).
            </p>
          ) : (
            <Suspense fallback={<p className="text-sm text-zinc-500">Loading map…</p>}>
              <MapErrorBoundary onError={() => setMapError(true)}>
                <PinMap lat={point.lat} lng={point.lng} onMove={movePin} />
              </MapErrorBoundary>
            </Suspense>
          )}
          <p className="text-xs text-zinc-500">Drag the pin, or click the map, to fine-tune the exact spot.</p>
          <button type="button" className="btn-accent" onClick={confirm}>
            Confirm location
          </button>
        </div>
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

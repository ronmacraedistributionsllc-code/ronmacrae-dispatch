import React, { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, Marker, Popup, NavigationControl, LngLatBounds } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useQuery } from "@tanstack/react-query";
import { API } from "@ronmacrae/contracts";
import type { RiderDto, RiderLocationDto } from "@ronmacrae/contracts";
import { apiFetch } from "../lib/api.js";
import { useRealtime } from "../lib/realtime.js";
import { OSM_STYLE } from "../lib/map-style.js";

const TRACKING_COLOR: Record<string, string> = {
  active: "#34d399",
  degraded: "#fbbf24",
  paused: "#a1a1aa",
  unavailable: "#71717a",
};

// Kingston, Jamaica — a reasonable default center before any rider position is known.
const DEFAULT_CENTER: [number, number] = [-76.7936, 17.9712];

function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/**
 * Live dispatcher map. Positions come from real rider GPS reports where a rider
 * has opted in and, otherwise, the preview location simulator — both feed the
 * same `rider.location` realtime message and the same bootstrap endpoint, so this
 * view can't tell (and doesn't claim to) which source a given point came from.
 * Staleness is shown honestly via each rider's own trackingState + last-update time.
 */
export function DispatchMap(): React.JSX.Element {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef(new Map<string, Marker>());
  const hasFitRef = useRef(false);
  const [locations, setLocations] = useState<Record<string, RiderLocationDto>>({});

  const riders = useQuery({ queryKey: ["riders"], queryFn: () => apiFetch<{ riders: RiderDto[] }>(API.riders.list) });
  const initial = useQuery({
    queryKey: ["rider-locations"],
    queryFn: () => apiFetch<{ locations: RiderLocationDto[] }>(API.riders.locations),
    refetchInterval: 30_000, // fallback; realtime (below) covers the common case
  });

  useEffect(() => {
    if (!initial.data) return;
    setLocations((cur) => {
      const next = { ...cur };
      for (const loc of initial.data.locations) next[loc.riderId] = loc;
      return next;
    });
  }, [initial.data]);

  const { subscribe, onReconnect } = useRealtime();
  useEffect(
    () =>
      subscribe(["rider.location"], (msg) => {
        if (msg.type !== "rider.location") return;
        setLocations((cur) => ({ ...cur, [msg.payload.riderId]: msg.payload }));
      }),
    [subscribe],
  );
  // A dropped socket can silently miss position updates — pull the latest
  // snapshot immediately on reconnect rather than waiting out the 30s poll.
  useEffect(() => onReconnect(() => void initial.refetch()), [onReconnect]);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new MapLibreMap({ container: mapContainer.current, style: OSM_STYLE, center: DEFAULT_CENTER, zoom: 10 });
    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const riderById = new Map((riders.data?.riders ?? []).map((r) => [r.id, r]));
    const seen = new Set<string>();
    let bounds: LngLatBounds | null = null;

    for (const [riderId, loc] of Object.entries(locations)) {
      seen.add(riderId);
      const name = riderById.get(riderId)?.name ?? "Courier";
      const lngLat: [number, number] = [loc.point.lng, loc.point.lat];
      let marker = markersRef.current.get(riderId);
      if (!marker) {
        const el = document.createElement("div");
        el.style.width = "16px";
        el.style.height = "16px";
        el.style.borderRadius = "50%";
        el.style.border = "2px solid white";
        el.style.boxShadow = "0 1px 3px rgba(0,0,0,0.5)";
        marker = new Marker({ element: el }).setLngLat(lngLat).setPopup(new Popup({ offset: 12 }).setText(name)).addTo(map);
        markersRef.current.set(riderId, marker);
      } else {
        marker.setLngLat(lngLat);
      }
      marker.getElement().style.background = TRACKING_COLOR[loc.trackingState] ?? TRACKING_COLOR.unavailable!;
      if (!bounds) bounds = new LngLatBounds(lngLat, lngLat);
      else bounds.extend(lngLat);
    }
    for (const [riderId, marker] of markersRef.current) {
      if (!seen.has(riderId)) {
        marker.remove();
        markersRef.current.delete(riderId);
      }
    }
    if (bounds && !hasFitRef.current && seen.size > 0) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 0 });
      hasFitRef.current = true;
    }
  }, [locations, riders.data]);

  const rows = Object.entries(locations).sort(([, a], [, b]) => b.at.localeCompare(a.at));

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Live map</h1>
        <p className="text-sm text-zinc-400">
          Courier positions update live while a courier has opted in to share their location (or, for a job with no real
          GPS yet, the preview simulator). Each marker's colour and the list below show how fresh a position is —
          treat anything not green as possibly stale.
        </p>
      </header>
      <section className="card">
        <div ref={mapContainer} className="h-[60vh] w-full overflow-hidden rounded-lg" />
      </section>
      <section className="card">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">Couriers on the map</h2>
        {rows.length === 0 ? (
            <p className="text-sm text-zinc-500">No courier positions yet.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="rider-map-list">
            {rows.map(([riderId, loc]) => (
              <li key={riderId} data-testid={`rider-row-${riderId}`} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-zinc-200">
                  <span className="inline-block size-2.5 rounded-full" style={{ background: TRACKING_COLOR[loc.trackingState] ?? TRACKING_COLOR.unavailable }} />
                  {riders.data?.riders.find((r) => r.id === riderId)?.name ?? "Courier"}
                </span>
                <span className="text-xs text-zinc-500">
                  {loc.trackingState} · {timeAgo(loc.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

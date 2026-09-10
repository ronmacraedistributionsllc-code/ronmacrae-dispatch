import React, { useEffect, useRef } from "react";
import { Map as MapLibreMap, Marker, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { OSM_STYLE } from "../lib/map-style.js";

/**
 * Small read-only map for the public customer tracking page — one marker, the
 * courier's last known point. The caller (track.tsx) is responsible for the
 * honesty labeling (trackingState + "last update" text); this component only
 * draws the point it's given, live or not.
 */
export function CourierMap({ lat, lng }: { lat: number; lng: number }): React.JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const map = new MapLibreMap({ container: container.current, style: OSM_STYLE, center: [lng, lat], zoom: 13 });
    map.addControl(new NavigationControl(), "top-right");
    markerRef.current = new Marker({ color: "#22c55e" }).setLngLat([lng, lat]).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Intentionally init-once (empty deps) — the effect below syncs position on change.
  }, []);

  useEffect(() => {
    mapRef.current?.setCenter([lng, lat]);
    markerRef.current?.setLngLat([lng, lat]);
  }, [lat, lng]);

  return <div ref={container} className="h-56 w-full overflow-hidden rounded-lg" />;
}
